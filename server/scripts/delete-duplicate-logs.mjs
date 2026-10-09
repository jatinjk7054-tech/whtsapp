import { config as dotenv } from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

// Deletes provable DUPLICATE verified logs: an unlinked verified money-log
// whose EXACT upi_transaction_id exists on ANOTHER log that is receipt-linked
// with the SAME amount (the twin holds the receipt -> the copy is redundant).
// Safety: backup manifest first; skips any log referenced by bank_audit_entries.
const DRY = process.argv.includes('--dry-run');

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const d = await c.query(`
    WITH un AS (
      SELECT l.id, l.amount_collected::numeric amt, l.upi_transaction_id AS upi
      FROM public.fro_donor_logs l
      WHERE l.accounts_status='verified' AND COALESCE(l.amount_collected,0)>0
        AND NOT EXISTS (SELECT 1 FROM public.receipts rc WHERE rc.log_id=l.id)
    )
    SELECT u.id dup_log, u.amt, u.upi,
           s.id kept_log, s.donor_id kept_donor_id, r.id receipt_id, r.receipt_no
    FROM un u
    JOIN public.fro_donor_logs s ON s.upi_transaction_id=u.upi AND s.id<>u.id
    JOIN public.receipts r ON r.log_id=s.id AND r.amount::numeric=u.amt
    ORDER BY u.id`);

  console.log(`Candidate duplicate copies: ${d.rowCount}`);

  // Guard: skip any candidate that a bank-audit entry points at.
  const ids = d.rows.map(r => r.dup_log);
  const guarded = new Set();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const g = await c.query(
        `SELECT DISTINCT matched_lead_log_id FROM public.bank_audit_entries WHERE matched_lead_log_id = ANY($1)`,
        [chunk]);
      for (const row of g.rows) guarded.add(row.matched_lead_log_id);
    }
  }
  const deletable = d.rows.filter(r => !guarded.has(r.dup_log));
  console.log(`Skipped (referenced by bank audit): ${d.rowCount - deletable.length}`);
  console.log(`Will ${DRY ? 'DELETE (dry-run)' : 'DELETE'}: ${deletable.length}\n`);
  for (const r of deletable) console.log(`DEL log#${r.dup_log} (${r.upi}) Rs.${r.amt} == KEEP log#${r.kept_log} receipt#${r.receipt_no || r.receipt_id}`);

  if (DRY) { await c.end(); return; }

  if (deletable.length) {
    // Backup manifest with full rows
    const full = await c.query(`SELECT * FROM public.fro_donor_logs WHERE id = ANY($1)`, [deletable.map(r => r.dup_log)]);
    const outDir = path.join(__dirname, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `deleted_dup_logs_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      deleted_at: new Date().toISOString(),
      reason: 'duplicate copy: identical upi on another log which is receipt-linked with same amount',
      mapping: deletable,
      rows: full.rows,
    }, null, 2));
    console.log(`\nBackup written: ${file}`);

    const del = await c.query(`DELETE FROM public.fro_donor_logs WHERE id = ANY($1) RETURNING id`,
      [deletable.map(r => r.dup_log)]);
    console.log(`Deleted: ${del.rowCount} duplicate logs`);

    // Donors whose totals may have been double-bumped by the import (report only)
    const donors = [...new Set(deletable.map(r => r.kept_donor_id).filter(Boolean))];
    if (donors.length) {
      const dp = await c.query(`SELECT id, name, total_amount, donation_count FROM public.donor_profiles WHERE id = ANY($1)`, [donors]);
      console.log(`\nDonors touched by duplicates (totals NOT auto-adjusted): ${dp.rowCount}`);
      for (const x of dp.rows) console.log(`  ${x.name} (Rs.${x.total_amount}, ${x.donation_count} donations)`);
    }
  }

  const after = await c.query(`
    SELECT count(*)::int n FROM public.fro_donor_logs l
    WHERE l.accounts_status='verified' AND COALESCE(l.amount_collected,0)>0
      AND NOT EXISTS (SELECT 1 FROM public.receipts rc WHERE rc.log_id=l.id)`);
  console.log(`\nRemaining unlinked verified money-logs: ${after.rows[0].n}`);

  const aug = await c.query(`SELECT count(*)::int n, sum(amount)::numeric tot FROM public.receipts WHERE receipt_date >= '2026-08-01'`);
  console.log(`Aug receipts untouched: ${aug.rows[0].n} / Rs.${aug.rows[0].tot}`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
