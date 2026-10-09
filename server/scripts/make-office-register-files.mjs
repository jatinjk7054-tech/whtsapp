import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const WORKBOOK = path.join(ROOT, 'ucs crm', 'Office_Asset_Register.xlsx');
const OUT_XLSX = path.join(ROOT, 'ucs crm', 'Office_Asset_Register_Import.xlsx');
const OUT_SQL = path.join(ROOT, 'backend', 'migrations', '100_assets_all_categories.sql');
const OUT_SUGGEST = path.join('C:/Users/ADMINI~1/AppData/Local/Temp/opencode', 'ar-suggestions.json');

const wb = XLSX.readFile(WORKBOOK);
const q = (n) => Number.isFinite(n) || String(n).trim() !== '' ? (Number(n) || 1) : 1;

const machines = [];
const computerData = XLSX.utils.sheet_to_json(wb.Sheets['Computer'], { header: 1, defval: '' });
computerData.forEach((r, i) => {
  if (i < 1) return;
  const raw = String(r[0] || '').trim();
  if (!raw) return;
  machines.push({
    code: raw.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' '),
    location: String(r[1] || '').trim(),
    category: String(r[2] || '').trim().replace(/\s+$/, ''),
    team_leader: String(r[3] || '').trim(),
    remarks: String(r[4] || '').trim(),
    quantity: 1,
  });
});

const SKIP_MACHINE_CATS = new Set(['Desktop', 'Laptop']);
const quantityLines = [];
const registerData = XLSX.utils.sheet_to_json(wb.Sheets['Asset Register'], { header: 1, defval: '' });
registerData.forEach((r, i) => {
  if (i < 3) return;
  const cat = String(r[2] || '').trim().replace(/\s+$/, '');
  if (!cat || SKIP_MACHINE_CATS.has(cat)) return;
  const desc = String(r[3] || '').trim();
  quantityLines.push({
    code: '',
    location: String(r[1] || '').trim(),
    category: cat,
    team_leader: '',
    remarks: desc,
    name: desc || cat,
    quantity: q(r[4]),
  });
});

// ---------- suggestions (unique descriptions per category) ----------
const suggest = {};
machines.forEach(m => (suggest[m.category] = suggest[m.category] || new Set()).add(m.category));
quantityLines.forEach(l => (suggest[l.category] = suggest[l.category] || new Set()).add(l.remarks || l.category));
const suggestOut = Object.fromEntries(Object.entries(suggest).map(([k, v]) => [k, [...v]]));
fs.writeFileSync(OUT_SUGGEST, JSON.stringify(suggestOut, null, 2));

// ---------- single-sheet Excel ----------
const rows = [
  ['Asset ID', 'Location', 'Category', 'Team-Leader', 'Description', 'Quantity'],
  ...machines.map(m => [m.code, m.location, m.category, m.team_leader, m.remarks, 1]),
  ...quantityLines.map(l => ['', l.location, l.category, '', l.remarks, l.quantity]),
];
const ws = XLSX.utils.aoa_to_sheet(rows);
ws['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 18 }, { wch: 42 }, { wch: 8 }];
const wbn = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbn, ws, 'Asset Register Import');
XLSX.writeFile(wbn, OUT_XLSX);

// ---------- migration SQL ----------
const S = s => String(s ?? '').trim();
const esc = s => String(s ?? '').replace(/'/g, "''");
const lines = [];
lines.push('-- 100: Seed the full Office Asset Register (all categories, idempotent)');
lines.push('-- Machines (Desktop/Laptop) dedupe by code; quantity lines dedupe by category + name + location.');
lines.push('-- Also clears any empty-string codes so quantity rows satisfy the UNIQUE index on (code).');
lines.push('');
lines.push('BEGIN;');
lines.push('');
lines.push(`UPDATE ${'assets'} SET code = NULL WHERE code = '';`);
lines.push('');

lines.push('-- Machines (Desktop/Laptop)');
for (let i = 0; i < machines.length; i += 1) {
  const m = machines[i];
  const row = `  ('${esc(m.code)}', '${esc(m.category)}', '${esc(m.category)}', ${m.location ? `'${esc(m.location)}'` : 'NULL'}, 1, ${m.team_leader ? `'${esc(m.team_leader)}'` : 'NULL'}, ${m.remarks ? `'${esc(m.remarks)}'` : 'NULL'}, 'available')`;
  if (i === 0) lines.push('INSERT INTO assets (code, name, category, location, quantity, team_leader, remarks, status) VALUES');
  lines.push(row + (i === machines.length - 1 ? '\nON CONFLICT (code) DO NOTHING;' : ','));
}
lines.push('');

lines.push('-- Quantity lines (all non-Desktop/Laptop categories)');
quantityLines.forEach(l => {
  lines.push(`INSERT INTO assets (name, category, location, quantity, remarks, status)`);
  lines.push(`SELECT '${esc(l.name)}', '${esc(l.category)}', ${l.location ? `'${esc(l.location)}'` : 'NULL'}, ${l.quantity}, ${l.remarks ? `'${esc(l.remarks)}'` : 'NULL'}, 'available'`);
  lines.push(`WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = '${esc(l.category)}' AND a.name = '${esc(l.name)}' AND ${l.location ? `a.location = '${esc(l.location)}'` : 'a.location IS NULL'});`);
  lines.push('');
});

lines.push('COMMIT;');
fs.writeFileSync(OUT_SQL, lines.join('\n'));

console.log(`Machines: ${machines.length} rows`);
console.log(`Quantity lines: ${quantityLines.length} rows`);
console.log(`Single sheet written: ${OUT_XLSX}`);
console.log(`Migration written: ${OUT_SQL}`);
console.log(`Suggestions written: ${OUT_SUGGEST}`);
console.log(`Suggested Excel rows total: ${1 + machines.length + quantityLines.length}`);