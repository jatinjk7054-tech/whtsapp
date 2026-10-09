import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const schema of ['public', 'test']) {
    const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='donor_profiles' ORDER BY ordinal_position`, [schema]);
    const cnt = await c.query(`SELECT count(*)::int n FROM ${schema}.donor_profiles`);
    console.log(`\n=== ${schema}.donor_profiles (${cnt.rows[0].n} rows) ===`);
    console.log(r.rows.map(x => x.column_name).join(', '));
  }
  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
