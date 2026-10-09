import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX = require('xlsx');

dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const OUT = 'C:\\Users\\ADMIN\\Desktop\\missing_receipt_numbers.xlsx';

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const lastNumericGroup = (s) => {
  const m = String(s).match(/\d+/g);
  return m ? parseInt(m[m.length - 1], 10) : null;
};

const run = async () => {
  await client.connect();

  // Same numeric-extraction logic getNextReceiptNo used pre-064: take the last
  // numeric group of receipt_no per project and find holes in 1..max.
  const { rows } = await client.query(
    `SELECT project_id, receipt_no FROM receipts WHERE receipt_no IS NOT NULL`
  );

  const byNgo = {};
  for (const r of rows) {
    const n = lastNumericGroup(r.receipt_no);
    if (n == null) continue;
    (byNgo[r.project_id] ||= new Set()).add(n);
  }

  const wb = XLSX.utils.book_new();
  const summary = [];

  for (const ngo of Object.keys(byNgo).sort()) {
    const nums = byNgo[ngo];
    const max = Math.max(...nums);
    const missing = [];
    for (let i = 1; i <= max; i++) if (!nums.has(i)) missing.push(i);

    const sheet = missing.length
      ? [['Missing receipt numbers for', ngo.toUpperCase()], ['Count', missing.length], [], ['Receipt No'], ...missing.map((n) => [n])]
      : [['Missing receipt numbers for', ngo.toUpperCase()], ['Count', 0], ['Status', 'Complete - no gaps']];
    sheet[0][1] = `${ngo} (max ${max})`;
    const ws = XLSX.utils.aoa_to_sheet(sheet);
    ws['!cols'] = [{ wch: 12 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws, ngo.toUpperCase());

    summary.push(`${ngo}: max ${max}, present ${nums.size}, missing ${missing.length}`);
  }

  XLSX.writeFile(wb, OUT);
  console.log(summary.join('\n'));
  console.log('->', OUT);
  await client.end();
};

run().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
