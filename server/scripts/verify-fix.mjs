import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log('=== Suspicious tier-4 targets in workers table ===');
  const s = await c.query(`SELECT name, department FROM workers
    WHERE lower(name) IN ('jayashree prajapati','ruchira mhatre','saira parbalkar','shweeta vishwakarma','jayshree prajapati','ruchira matre','saira prabalkar','sweta vishwakarma')`);
  for (const r of s.rows) console.log(`  "${r.name}" [${r.department}]`);

  console.log('\n=== Why Anjana Vyas unmatched? ===');
  const av = await c.query(`SELECT name, department, is_active FROM workers WHERE lower(name) LIKE '%anjana%' OR lower(name) LIKE '%vyas%'`);
  for (const r of av.rows) console.log(`  "${r.name}" [${r.department}]`);

  console.log('\n=== Prachi Dhanawade ===');
  const pd = await c.query(`SELECT name, department, is_active FROM workers WHERE lower(name) LIKE '%dhanawade%' OR lower(name) LIKE '%prachi%'`);
  for (const r of pd.rows) console.log(`  "${r.name}" [${r.department}]`);

  console.log('\n=== Suvita Shirvatkar ===');
  const su = await c.query(`SELECT name, department FROM workers WHERE lower(name) LIKE '%suvita%' OR lower(name) LIKE '%shirvatkar%' OR levenshtein(lower('Suvita Shirvatkar'), lower(trim(name))) <= 3`);
  for (const r of su.rows) console.log(`  "${r.name}" [${r.department}]`);

  console.log('\n=== Riddhi Patel ===');
  const rp = await c.query(`SELECT name, department FROM workers WHERE lower(name) LIKE '%riddhi%'`);
  for (const r of rp.rows) console.log(`  "${r.name}" [${r.department}]`);

  console.log('\n=== All FRO workers (name list) ===');
  const fw = await c.query(`SELECT name FROM workers WHERE upper(trim(department))='FRO' ORDER BY name`);
  console.log('  ' + fw.rows.map(r => r.name).join(' | '));

  // Verify what dashboard computes for Chhaya NOW
  console.log('\n=== Dashboard simulation: getTotalCollectedByWorker("Chhaya") Aug 2026 ===');
  const sim = await c.query(
    `SELECT count(*) n, sum(amount)::numeric total FROM receipts
     WHERE agent_name ILIKE 'Chhaya Kumari' AND receipt_date >= '2026-08-01' AND receipt_date <= '2026-08-31'`);
  console.log(`  ILIKE match: ${sim.rows[0].n} receipts, ₹${sim.rows[0].total}`);

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
