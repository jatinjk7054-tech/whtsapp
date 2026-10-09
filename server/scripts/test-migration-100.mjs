import { config as dotenv } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const url = new URL(process.env.DATABASE_URL);
url.hostname = 'localhost';
url.port = '5434';
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('BEGIN');
  // Read migration and strip its own BEGIN;/COMMIT; wrapper so the whole thing stays in our transaction.
  let sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '100_assets_all_categories.sql'), 'utf8');
  sql = sql.replace(/^\s*BEGIN;\s*\n/i, '').replace(/\n\s*COMMIT;\s*$/i, '');
  const { rowCount } = await client.query(sql);
  console.log(`Migration executed OK. Total statements/rows affected: ${rowCount}`);

  const q = async (label, query) => {
    const { rows } = await client.query(query);
    console.log(`\n### ${label}`);
    const out = rows.map(r => r.category ? `${r.category}: ${r.rows} rows / ${r.units} units` : JSON.stringify(r));
    console.log(out.join('\n'));
    return rows;
  };

  await q('count by category (after migration, in-transaction)', `
    SELECT category, COUNT(*)::int AS rows, COALESCE(SUM(quantity),0)::int AS units
    FROM assets GROUP BY category ORDER BY category`);

  const total = await client.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity),0)::int AS units FROM assets`);
  console.log(`\nTOTAL: ${total.rows[0].n} rows, ${total.rows[0].units} units`);

  await client.query('ROLLBACK');
  console.log('\nROLLED BACK — nothing persisted.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('MIGRATION TEST FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}