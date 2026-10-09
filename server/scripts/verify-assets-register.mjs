import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const WORKBOOK = path.join(__dirname, '..', '..', 'ucs crm', 'Office_Asset_Register.xlsx');
const API = 'https://api.beingsevak.org/api/assets';

const SNAP_CODES = { 'Desktop': 1, 'Laptop': 1, 'Android Mobile': 1, 'Nokia Mobile': 1 };

function normalizeCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ');
}

function parseWorkbook() {
  const wb = XLSX.readFile(WORKBOOK);
  const out = [];
  const sheets = [
    { name: 'Computer', dataFrom: 1, descCol: 4, qtyCol: 5, hasId: true },
    { name: 'Asset Register', dataFrom: 3, descCol: 3, qtyCol: 4, hasId: false },
  ];
  for (const { name, dataFrom, descCol, qtyCol, hasId } of sheets) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    data.forEach((r, i) => {
      if (i < dataFrom) return;
      const loc = String(r[1] || '').trim().replace(/\s+$/, '');
      const cat = String(r[2] || '').trim();
      if (!SNAP_CODES[cat]) return;
      const code = hasId ? normalizeCode(r[0]) : '';
      const desc = String(r[descCol] || '').trim();
      const qty = hasId ? 1 : (Number(r[qtyCol]) || 1);
      const name = hasId ? cat : (desc || cat);
      out.push({ code, name, category: cat, location: loc, quantity: qty });
    });
  }
  return out;
}

const token = jwt.sign({ id: 'seed-assets', email: 'seed-assets@local', role: 'accounts' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } });
const assets = await res.json();

const byCat = {};
for (const a of assets) {
  const key = a.category || 'unset';
  byCat[key] = byCat[key] || { rows: 0, units: 0 };
  byCat[key].rows++;
  byCat[key].units += (a.quantity || 1);
}
console.log('GET /api/assets status', res.status);
console.log('--- DB totals ---');
for (const [k, v] of Object.entries(byCat).sort()) console.log(`  ${k}: ${v.rows} row(s), ${v.units} unit(s)`);
console.log(`  TOTAL rows: ${assets.length}`);

console.log('--- workbook vs DB (missing = NOT in DB) ---');
const rows = parseWorkbook();
const byCode = new Map(assets.filter(a => a.code).map(a => [String(a.code), a]));
const missing = [];
let present = 0;
for (const w of rows) {
  let found;
  if (w.code) {
    found = byCode.get(String(w.code));
  } else {
    found = assets.find(a => !a.code && String(a.category || '') === w.category && String(a.name || '') === w.name && (a.location || '') === w.location);
  }
  if (found) present++;
  else missing.push(`${w.code || ''} | ${w.category} | ${w.name} | ${w.location}`);
}
console.log(`  workbook rows: ${rows.length} | present: ${present} | missing: ${missing.length}`);
for (const m of missing) console.log('  MISSING:', m);