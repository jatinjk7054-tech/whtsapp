import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBOOK = path.join(__dirname, '..', '..', 'ucs crm', 'Office_Asset_Register.xlsx');
const wb = XLSX.readFile(WORKBOOK);

// Computer sheet: qty = col5, data from row1, machines.
// Asset Register sheet: qty = col4, data from row3, quantity lines.
for (const [sheetName, dataFrom, qtyCol] of [['Computer', 1, 5], ['Asset Register', 3, 4]]) {
  const ws = wb.Sheets[sheetName];
  if (!ws) continue;
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log(`\n===== ${sheetName} (data from row#${dataFrom}, qty col ${qtyCol}) =====`);
  const stat = {};
  data.forEach((r, i) => {
    if (i < dataFrom) return;
    const cat = String(r[2] || '').trim().replace(/\s+$/, '');
    if (!cat) return;
    stat[cat] = stat[cat] || { lines: 0, units: 0, locations: new Set() };
    stat[cat].lines++;
    stat[cat].units += Number(r[qtyCol]) || 1;
    stat[cat].locations.add(String(r[1] || '').trim() || '(blank)');
  });
  for (const [k, v] of Object.entries(stat)) {
    console.log(`  ${k.padEnd(26)} lines=${String(v.lines).padStart(3)} units=${String(v.units).padStart(4)}  locs=${[...v.locations].join(', ')}`);
  }
}