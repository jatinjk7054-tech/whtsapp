// D2: apply the three "pure split" Excel files as the authority for
// donor -> station within each NGO.
//
//   bsct -> BOD-*   mann -> MOD-*   aflf -> AOD-*
//
// Rules:
//   * donor present in the file with a Station -> write it
//   * Station blank                            -> no change
//   * donor absent from the file               -> no change (never moved)
//   * ghost ids 307761 / 320534 / 308424       -> skipped; they alias onto
//     320535 / 323510, which have their own file rows
import pg from 'pg';
import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';

const DSN =
  process.env.DATABASE_URL ||
  'postgres://ucs_admin:ucscompany123@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/postgres';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const APPLY = process.argv.includes('--apply');

const GHOST_ALIAS = { 320534: 320535, 307761: 320535, 308424: 323510 };

const FILES = [
  { file: 'bsct pure split(new).xlsx', ngo: 'BSCT', prefix: 'BOD-' },
  { file: 'mann pure split(new).xlsx', ngo: 'MANN', prefix: 'MOD-' },
  { file: 'aflf pure split(new).xlsx', ngo: 'AFLF', prefix: 'AOD-' },
];

async function main() {
  const client = new pg.Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const ngoRows = await client.query('SELECT id, name FROM ngos');
  const ngoByName = {};
  for (const r of ngoRows.rows) ngoByName[r.name] = r.id;

  const report = {};

  for (const spec of FILES) {
    const ngoId = ngoByName[spec.ngo];
    if (!ngoId) throw new Error('NGO not found: ' + spec.ngo);

    const wb = xlsx.read(fs.readFileSync(path.join(REPO, spec.file)));
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });

    let skippedGhost = 0;
    let skippedBlank = 0;
    let wrongPrefix = 0;
    const changes = [];   // {donor_id, from, to}
    const noActiveRow = [];

    for (const r of rows) {
      const raw = String(r.DonorID);
      if (Object.prototype.hasOwnProperty.call(GHOST_ALIAS, raw)) { skippedGhost++; continue; }

      const station = r.Station && String(r.Station).trim()
        ? String(r.Station).trim() : null;
      if (!station) { skippedBlank++; continue; }

      if (!station.startsWith(spec.prefix)) { wrongPrefix++; continue; }

      const donorId = parseInt(raw, 10);
      if (!Number.isFinite(donorId)) continue;

      const cur = await client.query(
        `SELECT id, station FROM fro_assignments
          WHERE ngo_id = $1 AND donor_id = $2 AND status <> 'reassigned'`,
        [ngoId, donorId]);
      if (cur.rows.length === 0) { noActiveRow.push(donorId); continue; }

      const from = cur.rows[0].station;
      if (from === station) continue;
      changes.push({ id: cur.rows[0].id, donor_id: donorId, from, to: station });
    }

    console.log(`\n=== ${spec.ngo} (${spec.file}) ===`);
    console.log(`  file rows           : ${rows.length}`);
    console.log(`  skipped ghost alias : ${skippedGhost}`);
    console.log(`  skipped blank Stn   : ${skippedBlank}`);
    console.log(`  wrong prefix        : ${wrongPrefix}`);
    console.log(`  no active row       : ${noActiveRow.length}` +
      (noActiveRow.length ? ' -> ' + JSON.stringify(noActiveRow.slice(0, 10)) : ''));
    console.log(`  station changes     : ${changes.length}`);
    if (changes.length) {
      const nullToVal = changes.filter(c => c.from === null).length;
      const valueChange = changes.length - nullToVal;
      console.log(`      null -> value    : ${nullToVal}`);
      console.log(`      value -> value   : ${valueChange}`);
      console.log(`      sample          : ${JSON.stringify(changes.slice(0, 5))}`);
    }

    report[spec.ngo] = { changes, noActiveRow };

    if (APPLY && changes.length) {
      for (const ch of changes) {
        await client.query(
          `UPDATE fro_assignments SET station = $1
            WHERE id = $2 AND status <> 'reassigned' AND station IS DISTINCT FROM $1`,
          [ch.to, ch.id]);
      }
      console.log(`  APPLIED ${changes.length} station updates`);
    }
  }

  const total = Object.values(report).reduce((s, r) => s + r.changes.length, 0);
  const totalNoRow = Object.values(report).reduce((s, r) => s + r.noActiveRow.length, 0);
  console.log(`\nTOTAL station writes: ${total}`);
  console.log(`TOTAL donors in file with no active row: ${totalNoRow}`);
  if (!APPLY) console.log('DRY RUN — pass --apply to execute.');

  await client.end();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
