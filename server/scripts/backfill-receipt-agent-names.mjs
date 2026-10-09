import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

// Backfills receipts.agent_name from the receipt's linked log's worker
// (log.fro_worker_id, falling back to the assignment's worker). Only touches
// rows where agent_name IS NULL — never overwrites a real value.
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const before = await c.query(`
    SELECT r.id, r.receipt_no, r.amount, w.name worker_name
    FROM public.receipts r
    JOIN public.fro_donor_logs l ON l.id = r.log_id
    LEFT JOIN public.fro_assignments a ON a.id = l.assignment_id
    LEFT JOIN public.workers w ON w.id = COALESCE(l.fro_worker_id, a.fro_worker_id)
    WHERE r.agent_name IS NULL AND w.name IS NOT NULL
    ORDER BY r.id`);
  console.log(`Fixable NULL-agent receipts: ${before.rowCount}`);
  for (const r of before.rows) console.log(`  receipt#${r.id} (${r.receipt_no || 'no no.'}) Rs.${r.amount} -> "${r.worker_name}"`);

  if (before.rowCount > 0) {
    const upd = await c.query(`
      UPDATE public.receipts r
      SET agent_name = w.name
      FROM public.fro_donor_logs l
      LEFT JOIN public.fro_assignments a ON a.id = l.assignment_id
      LEFT JOIN public.workers w ON w.id = COALESCE(l.fro_worker_id, a.fro_worker_id)
      WHERE r.log_id = l.id AND r.agent_name IS NULL AND w.name IS NOT NULL`);
    console.log(`\nUpdated: ${upd.rowCount} receipts`);
  }

  const after = await c.query(`
    SELECT count(*)::int n FROM public.receipts r
    WHERE r.agent_name IS NULL AND r.log_id IS NOT NULL`);
  console.log(`Remaining NULL-agent receipts with a log (worker unresolvable): ${after.rows[0].n}`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
