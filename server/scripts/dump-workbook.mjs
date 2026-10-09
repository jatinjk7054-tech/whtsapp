import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBOOK = path.join(__dirname, '..', '..', 'ucs crm', 'Office_Asset_Register.xlsx');

const SNAP_CODES = { 'Desktop': 1, 'Laptop': 1, 'Android Mobile': 1, 'Nokia Mobile': 1 };
const wb = XLSX.readFile(WORKBOOK);

for (const sheetName of ['Computer', 'Asset Register']) {
  const ws = wb.Sheets[sheetName];
  if (!ws) { console.log('no sheet', sheetName); continue; }
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log(`\n===== ${sheetName} (${data.length} rows incl header) =====`);
  data.forEach((r, i) => {
    const cat = String(r[2] || '').trim();
    if (!SNAP_CODES[cat]) return;
    console.log(`row#${i} | [0]=${JSON.stringify(r[0])} | [1]=${JSON.stringify(r[1])} | [2]=${JSON.stringify(r[2])} | [3]=${JSON.stringify(r[3])} | [4]=${JSON.stringify(r[4])} | [5]=${JSON.stringify(r[5])} | [6]=${JSON.stringify(r[6])} | [7]=${JSON.stringify(r[7])}`);
  });
}