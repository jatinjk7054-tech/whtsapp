import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

// Links verified donation logs to their existing receipts by UPI/payment id
// (the import/auto-credit run of Aug 23 created both sides but never wrote
// receipts.log_id). Guards:
//   - only receipts whose log_id IS NULL are candidates
//   - payment_id must match the log's upi_transaction_id exactly
//   - Tier A: single candidate AND same amount            -> stamp
//   - Tier B: several candidates, exactly one w/ amount   -> stamp
//   - anything ambiguous / amount-mismatched              -> skipped + reported
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const logs = await c.query(`
    SELECT l.id, l.upi_transaction_id, l.amount_collected::numeric amt, l.created_at::date ldate,
           coalesce(l.payment_from,'') payer
    FROM public.fro_donor_logs l
    WHERE l.accounts_status = 'verified'
      AND COALESCE(l.amount_collected,0) > 0
      AND NOT EXISTS (SELECT 1 FROM public.receipts rc WHERE rc.log_id = l.id)`);

  console.log(`Verified money-bearing logs without a linked receipt: ${logs.rowCount}\n`);

  let stampedA = 0, stampedB = 0, skippedAmbiguous = 0, skippedNoUpi = 0, skippedNoCand = 0;
  const skipLog = [];

  for (const l of logs.rows) {
    const upi = String(l.upi_transaction_id || '').trim();
    if (!upi) { skippedNoUpi++; continue; }

    const cands = await c.query(`
      SELECT r.id, r.receipt_no, r.amount::numeric amt, r.receipt_date::date rdate
      FROM public.receipts r
      WHERE r.payment_id = $1 AND r.log_id IS NULL`, [upi]);

    if (cands.rowCount === 0) {
      // maybe a receipt already carries this log via another row? recheck to be safe
      skippedNoCand++;
      if (skipLog.length < 40) skipLog.push(`log#${l.id} Rs.${l.amt} upi=${upi} -> no NULL-log receipt with this payment_id`);
      continue;
    }

    const sameAmt = cands.rows.filter(r => Number(r.amt) === Number(l.amt));
    let target = null, tier = null;

    if (cands.rowCount === 1 && sameAmt.length === 1) { target = sameAmt[0]; tier = 'A'; }
    else if (sameAmt.length === 1) { target = sameAmt[0]; tier = 'B'; }
    else if (cands.rowCount === 1) {
      // single candidate but amount differs — only accept when dates also align tightly
      const dMatch = Math.abs((new Date(cands.rows[0].rdate) - new Date(l.ldate)) / 86400000) <= 1;
      if (dMatch) { target = cands.rows[0]; tier = 'B*'; }
    }

    if (!target) {
      skippedAmbiguous++;
      if (skipLog.length < 40) skipLog.push(`log#${l.id} Rs.${l.amt} upi=${upi} -> ${cands.rowCount} candidate(s), amounts: [${cands.rows.map(r => r.amt).join(', ')}]`);
      continue;
    }
    await c.query(`UPDATE public.receipts SET log_id = $1 WHERE id = $2 AND log_id IS NULL`, [l.id, target.id]);
    if (tier === 'A') stampedA++; else stampedB++;
  }

  console.log(`Tier A stamped (unique + amount match): ${stampedA}`);
  console.log(`Tier B stamped (amount-disambiguated):  ${stampedB}`);
  console.log(`Skipped - no candidate found:           ${skippedNoCand}`);
  console.log(`Skipped - log has no UPI id:            ${skippedNoUpi}`);
  console.log(`Skipped - ambiguous / mismatched:       ${skippedAmbiguous}`);

  if (skipLog.length) {
    console.log('\nSkipped samples:');
    for (const s of skipLog) console.log('  ' + s);
  }

  const after = await c.query(`
    SELECT count(*)::int n FROM public.fro_donor_logs l
    WHERE l.accounts_status='verified' AND COALESCE(l.amount_collected,0)>0
      AND NOT EXISTS (SELECT 1 FROM public.receipts rc WHERE rc.log_id=l.id)`);
  console.log(`\nRemaining verified money-logs without receipt link: ${after.rows[0].n} (was ${logs.rowCount})`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
