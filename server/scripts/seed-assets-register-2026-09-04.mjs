import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const WORKBOOK = path.join(__dirname, '..', '..', 'ucs crm', 'asset-register-2026-09-04 (1).xlsx');
const API = 'https://api.beingsevak.org/api/assets/import';

// XLSX headers -> DB columns
const COL_MAP = [
  'code', 'name', 'category', 'location', 'quantity', 'team_leader',
  'owner_name', 'brand', 'model', 'serial_no', 'storage', 'ram',
  'processor', 'motherboard', 'condition', 'status', 'assigned_to_name',
  'purchase_date', 'purchase_price', 'warranty_expiry', 'sim_number', 'remarks',
];

function parseWorkbook() {
  const wb = XLSX.readFile(WORKBOOK);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const rows = [];
  for (let i = 3; i < data.length; i++) {
    const raw = data[i];
    if (!raw || !raw[0]) continue;

    const row = {};
    for (let c = 0; c < COL_MAP.length; c++) {
      const val = String(raw[c] || '').trim();
      if (COL_MAP[c] === 'quantity') {
        row[COL_MAP[c]] = Number(val) || 1;
      } else {
        row[COL_MAP[c]] = val || null;
      }
    }
    if (!row.code) row.code = null;
    if (!row.status) row.status = 'available';
    row.history = [{ date: new Date().toISOString().slice(0, 10), text: 'Imported from Asset Register 2026-09-04' }];
    rows.push(row);
  }
  return rows;
}

const rows = parseWorkbook();
console.log(`Parsed ${rows.length} rows from xlsx`);

if (rows.length === 0) {
  console.log('No rows to import');
  process.exit(0);
}

const token = jwt.sign(
  { id: 'seed-assets', email: 'seed-assets@local', role: 'accounts' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

const res = await fetch(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ rows }),
});

const body = await res.json();
console.log('HTTP', res.status);
console.log(JSON.stringify(body, null, 2));
