import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX = require('xlsx');

dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const OUT = 'C:\\Users\\ADMIN\\Desktop\\suspense_1_10_aug.xlsx';

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const run = async () => {
  await client.connect();

  const { rows, rowCount } = await client.query(
    `SELECT r.id, r.receipt_no, r.donor_name, r.donor_mobile, r.amount,
            r.receipt_date, r.project_id, r.payment_id, r.agent_name, r.created_at
     FROM receipts r
     WHERE r.donor_id IS NULL
       AND r.log_id IS NULL
       AND (r.agent_name IS NULL OR r.agent_name = '' OR r.agent_name = 'Suspense')
       AND r.receipt_date BETWEEN '2026-08-01' AND '2026-08-10'
       AND NOT EXISTS (
         SELECT 1 FROM bank_audit_entries b WHERE b.receipt_id = r.id
       )
     ORDER BY r.receipt_date, r.id`
  );

  console.log('Count:', rowCount);
  for (const r of rows) {
    console.log(
      `${r.receipt_date} | #${r.receipt_no} | ${r.project_id || '-'} | ${r.donor_name || '-'} | ${r.donor_mobile || '-'} | ${r.amount} | ${r.payment_id || '-'}`
    );
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 20 }, { wch: 12 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Suspense');
  XLSX.writeFile(wb, OUT);
  console.log('Wrote', OUT);

  await client.end();
};

run().catch((e) => { console.error(e); process.exit(1); });
