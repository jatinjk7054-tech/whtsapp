import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log('=== Per-FRO collection, Aug 2026 (what dashboards will show) ===');
  const r = await c.query(`
    SELECT w.name, count(r.id) n, coalesce(sum(r.amount),0)::numeric total
    FROM workers w
    LEFT JOIN receipts r ON r.agent_name ILIKE w.name
       AND r.receipt_date >= '2026-08-01' AND r.receipt_date <= '2026-08-31'
    WHERE upper(trim(w.department))='FRO' AND lower(w.name) NOT IN ('suspense','library','pg','appdev')
    GROUP BY w.name HAVING count(r.id) > 0
    ORDER BY total DESC`);
  let t = 0;
  for (const x of r.rows) { console.log(`  ${x.name.padEnd(28)} ${String(x.n).padStart(4)} rcpts  Rs.${x.total}`); t += Number(x.total); }
  console.log(`  ${'-'.repeat(50)}\n  TOTAL: Rs.${t}`);

  const leftover = await c.query(`
    SELECT DISTINCT agent_name FROM receipts
    WHERE receipt_date >= '2026-08-01'
      AND agent_name IS NOT NULL AND btrim(agent_name) <> ''
      AND NOT EXISTS (SELECT 1 FROM workers w WHERE upper(trim(w.department))='FRO' AND lower(trim(agent_name))=lower(trim(w.name)))
      AND lower(btrim(agent_name)) NOT IN ('suspense','na','n/a','bank transfer','pay u money','payumoney','cheque','courier','office visit','ashram visit','library','rent','freecharge','savak data','cashlar','priyank shah','priyank sir')`);
  console.log(`\nUnmapped names still this month (${leftover.rowCount}):`);
  for (const x of leftover.rows) console.log(`  - "${x.agent_name}"`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
