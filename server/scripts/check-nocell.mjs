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
    `SELECT d.id, d.name, d.mobile_number, d.created_at::date,
            (SELECT count(*) FROM receipts rc WHERE rc.donor_id = d.id) AS receipts,
            (SELECT count(*) FROM fro_donor_logs l WHERE l.donor_id = d.id) AS logs,
            d.total_amount
     FROM donor_profiles d
     WHERE d.mobile_number LIKE 'NOCELL-%' AND d.created_at >= '2026-08-17'
     ORDER BY d.id`
  );
  console.log('NOCELL profiles created since Aug 17:', r.rows.length);
  for (const row of r.rows) {
    console.log(`#${row.id} | ${row.name} | created ${row.created_at} | receipts=${row.receipts} | logs=${row.logs} | total=${row.total_amount}`);
  }
  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });