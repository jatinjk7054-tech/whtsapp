import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const WORKBOOK = path.join(__dirname, '..', '..', 'ucs crm', 'Office_Asset_Register.xlsx');
const API = 'https://api.beingsevak.org/api/assets/import';

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
      out.push({
        code,
        name,
        category: cat,
        location: loc,
        team_leader: hasId ? String(r[3] || '').trim() : '',
        quantity: qty,
        remarks: hasId ? desc : '',
        status: 'available',
      });
    });
  }
  return out;
}

const rows = parseWorkbook();
const token = jwt.sign({ id: 'seed-assets', email: 'seed-assets@local', role: 'accounts' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const res = await fetch(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ rows }),
});

const body = await res.json();
console.log('HTTP', res.status);
console.log(JSON.stringify(body, null, 2));