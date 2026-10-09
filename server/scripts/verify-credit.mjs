import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const ids = fs.readFileSync(path.join(__dirname, 'target_payment_ids.txt'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((x) => x.trim().toUpperCase());

const run = async () => {
  await client.connect();

  const r = await client.query(
    `SELECT r.id, r.donor_name, r.donor_id, r.log_id, r.receipt_no, r.amount,
            r.payment_id, r.agent_name, d.name AS donor_profile
     FROM receipts r
     LEFT JOIN donor_profiles d ON d.id = r.donor_id
     WHERE upper(trim(r.payment_id)) = ANY($1::text[])`,
    [ids]
  );
  console.log('Total target receipts:', r.rows.length);
  console.log('Linked to donor:', r.rows.filter((x) => x.donor_id).length);
  console.log('Has receipt_no:', r.rows.filter((x) => x.receipt_no).length);
  console.log('Still unlinked:', r.rows.filter((x) => !x.donor_id).length);
  console.log('\nUnlinked/masked remaining:');
  for (const row of r.rows.filter((x) => !x.donor_id)) {
    console.log(`#${row.id} | ${row.donor_name} | amt=${row.amount} | upi=${row.payment_id} | agent=${row.agent_name}`);
  }

  const logs = await client.query(
    `SELECT count(*)::int AS cnt FROM fro_donor_logs
     WHERE accounts_status = 'verified'
       AND NOT EXISTS (SELECT 1 FROM receipts rc WHERE rc.log_id = fro_donor_logs.id)
       AND created_at >= '2026-08-17 12:00'`
  );
  console.log('\nOrphan verified logs (no linked receipt) created today:', logs.rows[0].cnt);

  const dup = await client.query(
    `SELECT upi_transaction_id, count(*) AS cnt FROM fro_donor_logs
     WHERE upi_transaction_id IN (SELECT payment_id FROM receipts WHERE upper(trim(payment_id)) = ANY($1::text[]))
     GROUP BY upi_transaction_id HAVING count(*) > 1`,
    [ids]
  );
  console.log('Duplicate logs per UPI:', dup.rows.length);

  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });