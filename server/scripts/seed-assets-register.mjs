import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const db = (await import('../src/config/db.js')).default;

const DRY_RUN = process.argv.includes('--dry-run');
const WORKBOOK = path.join(__dirname, '..', '..', 'ucs crm', 'Office_Asset_Register.xlsx');
const TODAY = new Date().toISOString().slice(0, 10);

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
    if (!ws) {
      console.log(`[skip] sheet "${name}" not found`);
      continue;
    }
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
        _source: name,
        code,
        name,
        category: cat,
        location: loc,
        team_leader: hasId ? String(r[3] || '').trim() : '',
        quantity: qty,
        remarks: hasId ? desc : '',
      });
    });
  }
  return out;
}

function summarize(rows) {
  const byCat = {};
  let machines = 0;
  let phoneLines = 0;
  let totalUnits = 0;
  for (const r of rows) {
    byCat[r.category] = (byCat[r.category] || 0) + 1;
    totalUnits += r.quantity || 0;
    if (r.code) machines++; else phoneLines++;
  }
  return { byCat, machines, phoneLines, totalUnits };
}

async function main() {
  console.log(`[info] DRY_RUN=${DRY_RUN}`);
  console.log(`[info] workbook=${WORKBOOK}`);

  const { rows: cols } = await db._pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='assets' ORDER BY ordinal_position`
  );
  console.log(`[info] assets columns (${cols.length}): ${cols.map(c => c.column_name).join(', ')}`);

  const { rows: existingAll } = await db._pool.query(
    `SELECT category, COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS units FROM assets GROUP BY category ORDER BY category`
  );
  console.log('[info] existing assets in DB:');
  for (const r of existingAll) console.log(`         ${r.category}: ${r.rows} row(s), ${r.units} unit(s)`);

  const parsed = parseWorkbook();
  const sum = summarize(parsed);
  console.log(`[info] parsed from workbook: ${parsed.length} rows | machines=${sum.machines} phoneLines=${sum.phoneLines} totalUnits=${sum.totalUnits}`);
  console.log('[info] by category:', JSON.stringify(sum.byCat));

  if (DRY_RUN) {
    console.log('\n[preview] rows to insert:');
    parsed.forEach((r, i) => {
      console.log(`  ${String(i + 1).padStart(2)} | ${r.code.padEnd(14) || '—'.padEnd(14)} | ${r.category.padEnd(13)} | ${String(r.location).padEnd(18) || '—'.padEnd(18)} | qty=${String(r.quantity).padStart(3)} | tl=${r.team_leader || '—'} | ${r.remarks ? r.remarks.slice(0, 40) : ''}`);
    });
    console.log('\n[dry-run] nothing inserted. Run without --dry-run to insert.');
    process.exit(0);
  }

  const inserted = [];
  const skipped = [];
  const errors = [];

  for (const raw of parsed) {
    const row = {
      code: raw.code || null,
      name: raw.name,
      category: raw.category,
      location: raw.location || null,
      team_leader: raw.team_leader || null,
      quantity: raw.quantity || 1,
      remarks: raw.remarks || null,
      status: 'available',
      history: [{ date: TODAY, text: 'Imported from Office Asset Register' }],
    };

    let dupQuery = { code: row.code, label: row.code };
    if (row.code) {
      const { rows } = await db._pool.query('SELECT id FROM assets WHERE code = $1 LIMIT 1', [row.code]);
      if (rows.length) { skipped.push({ code: row.code, reason: 'Already exists (by code)' }); continue; }
    } else {
      dupQuery.label = `${row.category} / ${row.name} @ ${row.location || 'no location'}`;
      let res;
      if (row.location) {
        res = await db._pool.query('SELECT id FROM assets WHERE category = $1 AND name = $2 AND location = $3 LIMIT 1', [row.category, row.name, row.location]);
      } else {
        res = await db._pool.query('SELECT id FROM assets WHERE category = $1 AND name = $2 AND location IS NULL LIMIT 1', [row.category, row.name]);
      }
      if (res.rows.length) { skipped.push({ code: dupQuery.label, reason: 'Already exists (phone line)' }); continue; }
    }

    const { data, error } = await db.from('assets').insert(row).select().single();
    if (error) {
      errors.push({ code: dupQuery.label, error: error.message });
      console.log(`[ERROR] ${dupQuery.label}: ${error.message}`);
      continue;
    }
    inserted.push(data);
  }

  console.log(`\n[result] inserted=${inserted.length} skipped=${skipped.length} errors=${errors.length}`);
  for (const s of skipped) console.log(`[skip]   ${s.code} — ${s.reason}`);
  for (const e of errors) console.log(`[err]    ${e.code} — ${e.error}`);

  const { rows: after } = await db._pool.query(
    `SELECT category, COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS units FROM assets GROUP BY category ORDER BY category`
  );
  console.log('\n[verify] assets after seed:');
  for (const r of after) console.log(`         ${r.category}: ${r.rows} row(s), ${r.units} unit(s)`);

  await db._pool.end();
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});