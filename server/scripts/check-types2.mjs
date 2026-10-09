import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const run = async () => {
  await client.connect();
  const r = await client.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_name IN ('ngos','fro_assignments')
       AND column_name IN ('id','ngo_id','fro_worker_id')
     ORDER BY table_name, column_name`
  );
  for (const row of r.rows) console.log(`${row.table_name}.${row.column_name}: ${row.data_type}`);

  const ngo = await client.query(`SELECT id, name FROM ngos ORDER BY id LIMIT 5`);
  console.log('ngos sample:', JSON.stringify(ngo.rows));

  // Test the exact failing query
  const test = await client.query(
    `SELECT id FROM fro_assignments
     WHERE donor_id = $1 AND ($2::uuid IS NULL OR fro_worker_id = $2) AND ($3::int IS NULL OR ngo_id = $3)
     ORDER BY id LIMIT 1`,
    [357844, null, null]
  );
  console.log('ensureAssignment test (no worker, no ngo):', JSON.stringify(test.rows));
  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });