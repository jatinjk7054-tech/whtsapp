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
    `SELECT l.id, l.donor_id, l.amount_collected, l.upi_transaction_id, l.accounts_status, l.created_at::date,
            (SELECT count(*) FROM receipts rc WHERE rc.log_id = l.id) AS linked_receipts
     FROM fro_donor_logs l
     WHERE l.created_at >= '2026-08-17 12:00' AND l.accounts_status = 'verified'
       AND (SELECT count(*) FROM receipts rc WHERE rc.log_id = l.id) = 0
     ORDER BY l.id`
  );
  console.log('Verified logs with NO linked receipt (created today):', r.rows.length);
  for (const row of r.rows) {
    console.log(`log#${row.id} | donor=${row.donor_id} | amt=${row.amount_collected} | upi=${row.upi_transaction_id} | ${row.accounts_status} | ${row.created_at}`);
  }
  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });