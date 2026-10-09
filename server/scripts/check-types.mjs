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
     WHERE table_name IN ('fro_donor_logs','fro_assignments','workers','donor_profiles')
       AND column_name IN ('id','fro_worker_id','donor_id','created_by','assignment_id','verified_by')
     ORDER BY table_name, column_name`
  );
  for (const row of r.rows) console.log(`${row.table_name}.${row.column_name}: ${row.data_type}`);
  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });