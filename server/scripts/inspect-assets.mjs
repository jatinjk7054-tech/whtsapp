import { config as dotenv } from 'dotenv';
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

const q = async (label, sql, params = []) => {
  const { rows } = await client.query(sql, params);
  console.log(`\n### ${label}`);
  console.log(JSON.stringify(rows, null, 1));
  return rows;
};

await q('indexes/constraints on assets', `
  SELECT c.relname, i.indexrelid::regclass AS index_name, i.indisunique,
         pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  WHERE c.relname = 'assets'`);

await q('columns + nullability', `
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns WHERE table_schema='public' AND table_name='assets' ORDER BY ordinal_position`);

await q('rows where category LIKE Nokia/Android', `
  SELECT id, code, category, name, location, quantity::int FROM assets
  WHERE category ILIKE '%okia%' OR category ILIKE '%ndroid%' ORDER BY category, location`);

await q('count by category', `
  SELECT category, COUNT(*)::int AS rows, COALESCE(SUM(quantity),0)::int AS units FROM assets GROUP BY category ORDER BY category`);

await q('the exact dedupe query (Nokia @ AFLF Cabin)', `
  SELECT id FROM assets WHERE ("category" = $1) AND ("name" = $2) AND ("location" = $3) LIMIT 1`,
  ['Nokia Mobile', 'Nokia Mobile', 'AFLF Cabin']);

await q('any row with empty/null code', `
  SELECT id, code, category, name, location, quantity::int FROM assets WHERE code IS NULL OR code = '' ORDER BY created_at`);

await client.end();