import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Client } = require('pg');

const ids = fs.readFileSync(path.join(__dirname, 'target_payment_ids.txt'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((x) => x.trim().toUpperCase());

const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const run = async () => {
  await client.connect();
  const r = await client.query(
    `SELECT upper(trim(payment_id)) AS pid, id, donor_name, donor_id, log_id, agent_name, amount
     FROM receipts WHERE upper(trim(payment_id)) = ANY($1::text[])`,
    [ids]
  );
  console.log('receipts found:', r.rows.length);
  const found = new Set(r.rows.map((x) => x.pid));
  for (const row of r.rows) {
    console.log(
      `${row.pid} | id=${row.id} | donor=${row.donor_name} | donor_id=${row.donor_id} | log_id=${row.log_id} | agent=${row.agent_name} | amt=${row.amount}`
    );
  }
  console.log('\n=== NOT FOUND in receipts table ===');
  for (const id of ids) {
    if (!found.has(id)) console.log(id);
  }
  await client.end();
};

run().catch((e) => { console.error(e); process.exit(1); });