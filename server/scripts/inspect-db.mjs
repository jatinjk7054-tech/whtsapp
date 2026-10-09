import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = (await import('pg')).default ?? await import('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  await c.connect();

  try {
    const w = await c.query('SELECT count(*) n FROM workers');
    console.log('workers rows:', w.rows[0].n);
    const wd = await c.query('SELECT department, count(*) n FROM workers GROUP BY department ORDER BY n DESC LIMIT 10');
    console.log('workers departments:', JSON.stringify(wd.rows));
    const wc = await c.query("SELECT id, name FROM workers WHERE lower(name) LIKE '%chhaya%'");
    console.log('chhaya in workers:', JSON.stringify(wc.rows));
  } catch (e) { console.log('workers err:', e.message); }

  try {
    const ud = await c.query("SELECT role, count(*) n FROM users GROUP BY role ORDER BY n DESC LIMIT 15");
    console.log('users roles:', JSON.stringify(ud.rows));
    const uc = await c.query("SELECT id, name, role FROM users WHERE lower(name) LIKE '%chhaya%'");
    console.log('chhaya in users:', JSON.stringify(uc.rows));
  } catch (e) { console.log('users err:', e.message); }

  try {
    const cols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position");
    console.log('users columns:', JSON.stringify(cols.rows.map(r => r.column_name)));
  } catch (e) { console.log(e.message); }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
