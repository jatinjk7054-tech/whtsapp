import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX = require('xlsx');

dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const OUT = 'C:\\Users\\ADMIN\\Desktop\\duplicate_receipts_review_v2.xlsx';

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const COLS = ['Group', 'Role', 'Receipt ID', 'Receipt No', 'Amount', 'Receipt Date',
              'Time', 'Payment ID', 'Donor Name', 'Donor Mobile', 'Project', 'Created At'];

const buildRows = (rows, groupLabel) => {
  const groups = {};
  for (const r of rows) {
    const key = groupLabel(r);
    (groups[key] ||= []).push(r);
  }
  const sheet = [];
  for (const [key, members] of Object.entries(groups)) {
    members.forEach((m, i) => {
      sheet.push([
        key,
        i === 0 ? 'MAIN (keep)' : 'DUP (delete?)',
        m.id,
        m.receipt_no,
        Number(m.amount),
        m.receipt_date ? String(m.receipt_date).slice(0, 10) : '',
        m.receipt_time || '',
        m.payment_id,
        m.donor_name,
        m.donor_mobile,
        m.project_id,
        m.created_at ? new Date(m.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
      ]);
    });
  }
  return { sheet, groupCount: Object.keys(groups).length };
};

const run = async () => {
  await client.connect();

  // Rule: same amount + same receipt date + same receipt time (time recorded)
  const confirmed = (await client.query(`
    SELECT id, receipt_no, amount, receipt_date, receipt_time, payment_id,
           donor_name, donor_mobile, project_id, created_at
      FROM receipts
     WHERE donor_id IS NULL AND log_id IS NULL
       AND receipt_time IS NOT NULL
       AND (amount, receipt_date, receipt_time) IN (
         SELECT amount, receipt_date, receipt_time FROM receipts
         WHERE donor_id IS NULL AND log_id IS NULL AND receipt_time IS NOT NULL
         GROUP BY 1, 2, 3 HAVING count(*) > 1
       )
     ORDER BY amount, receipt_date, receipt_time, id
  `)).rows;

  // Same amount + same date but NO time recorded -> manual review only
  const noTime = (await client.query(`
    SELECT id, receipt_no, amount, receipt_date, receipt_time, payment_id,
           donor_name, donor_mobile, project_id, created_at
      FROM receipts
     WHERE donor_id IS NULL AND log_id IS NULL
       AND receipt_time IS NULL
       AND (amount, receipt_date) IN (
         SELECT amount, receipt_date FROM receipts
         WHERE donor_id IS NULL AND log_id IS NULL AND receipt_time IS NULL
         GROUP BY 1, 2 HAVING count(*) > 1
       )
     ORDER BY amount, receipt_date, id
  `)).rows;

  const c = buildRows(confirmed, (r) => `${r.amount} | ${String(r.receipt_date).slice(0, 10)} | ${r.receipt_time}`);
  const n = buildRows(noTime, (r) => `${r.amount} | ${String(r.receipt_date).slice(0, 10)}`);

  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.aoa_to_sheet([
    ['DUPLICATES BY RULE: same amount + same receipt date + same receipt time (unlinked/suspense receipts)'],
    ['Groups', c.groupCount, 'Rows', c.sheet.length, 'To delete', c.sheet.length - c.groupCount],
    [],
    COLS,
    ...c.sheet,
  ]);
  ws1['!cols'] = [{ wch: 26 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
                  { wch: 12 }, { wch: 8 }, { wch: 20 }, { wch: 24 }, { wch: 14 }, { wch: 8 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'By rule (confirmed)');

  const ws2 = XLSX.utils.aoa_to_sheet([
    ['REVIEW ONLY: same amount + same date, but NO time recorded - cannot confirm same time, decide manually'],
    ['Groups', n.groupCount, 'Rows', n.sheet.length],
    [],
    COLS,
    ...n.sheet,
  ]);
  ws2['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
                  { wch: 12 }, { wch: 8 }, { wch: 20 }, { wch: 24 }, { wch: 14 }, { wch: 8 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'No time - review');

  XLSX.writeFile(wb, OUT);
  console.log(`confirmed: ${c.groupCount} groups / ${c.sheet.length} rows | noTime: ${n.groupCount} groups / ${n.sheet.length} rows`);
  await client.end();
};

run().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});

