import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = path.resolve(__dirname, '..', '..', 'ucs crm', 'asset-register-2026-09-04 (1).xlsx');
const OUT_PATH = path.resolve(__dirname, '..', 'migrations', '110_update_asset_specs.sql');

const wb = XLSX.readFile(XLSX_PATH);
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const lines = [];
lines.push('-- Migration 110: Update existing assets with specification data from Asset Register 2026-09-04');
lines.push('-- Run this in Supabase SQL Editor');
lines.push('');

const esc = (s) => String(s || '').trim().replace(/'/g, "''");
const textOrNull = (v) => { const s = String(v || '').trim(); return s ? "'" + esc(s) + "'" : 'NULL'; };
const numOrNull = (v) => { const n = Number(v); return isNaN(n) || n === 0 ? 'NULL' : String(n); };
const dateOrNull = (v) => { const s = String(v || '').trim(); return s ? "'" + esc(s) + "'" : 'NULL'; };

let count = 0;
for (let i = 3; i < data.length; i++) {
  const r = data[i];
  if (!r || !r[0]) continue;
  const cells = Array.isArray(r[0]) && String(r[0]).includes('\t') ? String(r[0]).split('\t') : r;
  const code = (cells[0] || '').trim();
  if (!code) continue;
  count++;

  const vals = {
    name: "'" + esc(cells[1]) + "'",
    location: textOrNull(cells[3]),
    team_leader: textOrNull(cells[5]),
    owner_name: textOrNull(cells[6]),
    brand: textOrNull(cells[7]),
    model: textOrNull(cells[8]),
    serial_no: textOrNull(cells[9]),
    storage: textOrNull(cells[10]),
    ram: textOrNull(cells[11]),
    processor: textOrNull(cells[12]),
    motherboard: textOrNull(cells[13]),
    condition: textOrNull(cells[14]),
    status: textOrNull(cells[15]) || "'available'",
    assigned_to_name: textOrNull(cells[16]),
    purchase_date: dateOrNull(cells[17]),
    purchase_price: numOrNull(cells[18]),
    warranty_expiry: dateOrNull(cells[19]),
    sim_number: textOrNull(cells[20]),
    remarks: textOrNull(cells[21]),
  };

  lines.push("UPDATE assets SET");
  const entries = Object.entries(vals);
  entries.forEach(([k, v], idx) => {
    lines.push("  " + k + " = " + v + ",");
  });
  lines.push("  updated_at = NOW()");
  lines.push("WHERE code = '" + esc(code) + "';");
  lines.push('');
}

lines.push('-- Total: ' + count + ' UPDATE statements');
fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf8');
console.log('Written', count, 'UPDATE statements to', OUT_PATH);
