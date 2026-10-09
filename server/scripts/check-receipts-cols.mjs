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
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns WHERE table_name = 'receipts' ORDER BY ordinal_position`
  );
  for (const row of r.rows) console.log(`${row.column_name}: ${row.data_type} null=${row.is_nullable}`);
  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });