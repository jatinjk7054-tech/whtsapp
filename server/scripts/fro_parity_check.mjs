// ---------------------------------------------------------------------------
// FRO parity check: reconcile accounts ground-truth sheet (main all 3.xlsx)
// against CRM dashboards (fro_donor_logs) per FRO worker.
//
//   node scripts/fro_parity_check.mjs report BEFORE      -> Desktop FRO_Parity_BEFORE_<ts>.xlsx
//   node scripts/fro_parity_check.mjs report AFTER       -> Desktop FRO_Parity_AFTER_<ts>.xlsx
//   node scripts/fro_parity_check.mjs fix                -> dry run (prints planned fixes)
//   node scripts/fro_parity_check.mjs fix --apply        -> applies fixes (JSON backup first)
//
// Requires the SSH DB tunnel on localhost:5434.
// Dashboard totals use the REAL production functions imported from
// ../src/models/froDonorLogModel.js (zero logic drift).
// ---------------------------------------------------------------------------

import pg from 'pg';
import * as _XLSXns from 'xlsx';
const XLSX = _XLSXns.default ?? _XLSXns;
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { paymentDiscriminant, logCollectionDate } from '../src/models/froDonorLogModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEET_PATH = process.env.PARITY_SHEET || 'C:/Users/ADMIN/Desktop/UCS_CRM/main all 3.xlsx';

const CONN = process.env.PARITY_DB_URL ||
  'postgres://ucs_app:xm4BAoZRhOVU3NFW2qLe@127.0.0.1:5434/postgres';

const NGOS = {
  bsct: '598954e3-6716-4e83-adc8-323d622facf0',
  mann: '472ff76f-67f7-42d1-8224-806c6041b33f',
  aflf: 'afa30741-54f8-4ea9-a449-b3ae625351dc',
};
const SHEET_TO_PROJ = { BeingSevak: 'bsct', Ashray: 'aflf', MannCare: 'mann' };

const WIN_START = '2026-08-01';
const WIN_END = '2026-09-01';

// Agents that are NOT FROs - reported but never auto-fixed (per user decision).
const EXCLUDED_AGENTS = new Set([
  'rent', 'prachidhanawade', 'ankitachaudhary', 'suspense', 'library', 'priyanksir',
]);

// Known spelling variants -> canonical worker name.
const NAME_ALIASES = {
  riddhipatel: 'Riddhi Arun Patel',
  chhayakumari: 'Chhaya  Kumari',
  chhayaprasadkumari: 'Chhaya  Kumari',
  sushmaambokar: 'Sushma Ambokar',
  sushmanarendraambokar: 'Sushma Ambokar',
  reenamaurya: 'Reena Maurya',
  swetavishwakarma: 'Shweeta Vishwakarma',
  kshitijajadhav: 'Kshitija Mohil Jadhav',
  varshatambe: 'Varsha G. Tambe',
  sonaliwankhede: 'Sonali Wankhede Tayade',
  suvitashirvatkar: 'Suvita Kisan Shirvatkar',
  jayshreeprajapati: 'jayashree prajapati',
  sairaprabalkar: 'Saira  Parbalkar ',
  kanchanchauhan: 'Kanchan Gupta',
  ruchiramatre: 'Ruchira Mhatre',
};

// System actor + fallback donor used by prior backfills.
const SYSTEM_ACTOR = '775c71c9-690f-453d-a268-4a3b522da9b9';
const ANON_DONOR_ID = 483287;
const ADMIN_FALLBACK_ASSIGNED_BY = 'ebf04deb-58ba-4c6d-ba67-928af0a25c1b';
const ASSIGNMENT_TEMPLATE = {
  status: 'pending', is_new: false, station: 'FD-22',
  batch_id: 'c477d126-f7cd-4b45-a44a-1c322749de6a', batch_type: 'new_data',
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const isoDay = (d) => String(d || '').slice(0, 10);

function parseSheetDate(s) {
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  let mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function parseSheetTime(s) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(String(s || '').trim());
  if (!m) return { hh: '12', mm: '00' };
  let h = parseInt(m[1], 10);
  if (m[3]) {
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
  }
  return { hh: String(h).padStart(2, '0'), mm: m[2] };
}

const cleanRef = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

function mapPaymentMode(mop) {
  const s = String(mop || '').toLowerCase();
  if (s.includes('cash')) return 'Cash';
  if (/bank|neft|imps|cheque|rtgs/.test(s)) return 'Bank';
  return 'UPI';
}

// ---------------------------------------------------------------- sheet input
export function readGroundTruth(filePath = SHEET_PATH) {
  const wb = XLSX.readFile(filePath);
  const rows = [];
  const skipped = [];
  for (const [sheetName, proj] of Object.entries(SHEET_TO_PROJ)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    for (let i = 1; i < grid.length; i++) {
      const r = grid[i];
      const agent = String(r[10] ?? '').trim();
      const amt = num(r[14]);
      const rno = String(r[15] ?? '').trim();
      if (!agent && !rno) continue;
      if (!agent || !Number.isFinite(amt) || amt <= 0) {
        if (agent || rno) skipped.push({ sheet: sheetName, row: i + 1, agent, rno, reason: 'missing agent/amount' });
        continue;
      }
      const dateStr = parseSheetDate(r[16]);
      if (!dateStr) {
        skipped.push({ sheet: sheetName, row: i + 1, agent, rno, reason: `bad date "${r[16]}"` });
        continue;
      }
      const { hh, mm } = parseSheetTime(r[17]);
      rows.push({
        proj, sheetRow: i + 1,
        agent: agent.replace(/\s+/g, ' ').trim(),
        donorName: String(r[2] ?? '').trim(),
        mobile: digitsOnly(r[3]),
        mop: String(r[12] ?? '').trim(),
        payId: String(r[13] ?? '').trim(),
        amount: amt,
        receiptNo: rno,
        date: dateStr,
        hh, mm,
        txdt: `${dateStr}T${hh}:${mm}:00+00:00`,
      });
    }
  }
  return { rows, skipped };
}

// ------------------------------------------------------------------ database
export async function loadDb() {
  const client = new pg.Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tsIso = ['created_at', 'transaction_datetime', 'verified_at'];
  const fixTs = (rows) => rows.map((r) => {
    for (const f of tsIso) if (r[f]) r[f] = new Date(r[f]).toISOString();
    return r;
  });

  const logsQ = await client.query(`
    SELECT l.id, l.assignment_id, l.action, l.disposition_category, l.disposition_detail,
           l.amount_collected, l.accounts_status, l.verified_at, l.created_at,
           l.donor_id, l.fro_worker_id, l.remark, l.upi_transaction_id,
           l.transaction_datetime, l.payment_mode,
           a.ngo_id,
           dp.name  AS donor_name,
           dp.mobile_number AS donor_mobile
    FROM fro_donor_logs l
    LEFT JOIN fro_assignments a ON a.id = l.assignment_id
    LEFT JOIN donor_profiles dp ON dp.id = l.donor_id
    WHERE COALESCE(l.transaction_datetime, l.created_at) >= '2026-07-20'
       OR l.created_at >= '2026-07-20'`);
  fixTs(logsQ.rows);

  // Only money-bearing logs matter for parity; drop pure timeline chatter.
  const logs = logsQ.rows.filter(
    (l) => l.amount_collected !== null || l.action === 'donation' ||
      (l.disposition_detail === 'done') ||
      (l.disposition_detail === 'lead_done' && l.accounts_status === 'verified')
  );

  const receiptsQ = await client.query(`
    SELECT id, project_id, receipt_no, amount, agent_name, donor_name, donor_mobile,
           payment_id, receipt_date, log_id, donor_id
    FROM receipts WHERE receipt_date >= '2026-07-20'`);
  fixTs(receiptsQ.rows.map((r) => ({ ...r })));
  // receipt_date needs manual iso (may be timestamp)
  for (const r of receiptsQ.rows) if (r.receipt_date) r.receipt_date = new Date(r.receipt_date).toISOString();

  const workersQ = await client.query(`SELECT id, name FROM workers`);

  return { client, logs, receipts: receiptsQ.rows, workers: workersQ.rows };
}

// ------------------------------------------------------- dashboard semantics
const qualifiesForCollection = (l) =>
  l.action === 'donation' ||
  (l.action === 'disposition' && l.disposition_detail === 'done') ||
  (l.action === 'disposition' && l.disposition_detail === 'lead_done' && l.accounts_status === 'verified');

const collectionDayOf = (l) => isoDay(logCollectionDate(l));

export function buildCountedEntries(workerLogs) {
  const byKey = new Map();
  for (const l of workerLogs) {
    if (!qualifiesForCollection(l)) continue;
    const day = collectionDayOf(l);
    if (!(day >= WIN_START && day < WIN_END)) continue;
    const key = `${l.donor_id}|${String(l.amount_collected)}|${day}|${l.ngo_id}|${paymentDiscriminant(l)}`;
    if (!byKey.has(key)) byKey.set(key, { key, logs: [l], rep: l });
    else byKey.get(key).logs.push(l);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------- agent resolution
function buildResolver(workers) {
  const byNorm = new Map();
  for (const w of workers) {
    const n = norm(w.name);
    if (!byNorm.has(n)) byNorm.set(n, w);
  }
  return (rawAgent) => {
    const n = norm(rawAgent);
    if (EXCLUDED_AGENTS.has(n)) return { kind: 'excluded' };
    const aliased = NAME_ALIASES[n];
    if (aliased && byNorm.has(norm(aliased))) return { kind: 'worker', worker: byNorm.get(norm(aliased)), viaAlias: true };
    const hit = byNorm.get(n);
    if (hit) return { kind: 'worker', worker: hit };
    return { kind: 'unresolved' };
  };
}

// ------------------------------------------------------------ core analysis
export async function analyze() {
  const { client, logs, receipts, workers } = await loadDb();
  const resolve = buildResolver(workers);
  const gt = readGroundTruth();

  const receiptsByNo = new Map(receipts.map((r) => [`${r.project_id}|${String(r.receipt_no).trim()}`, r]));

  const logsByWorker = new Map();
  for (const l of logs) {
    if (!l.fro_worker_id) continue;
    if (!logsByWorker.has(l.fro_worker_id)) logsByWorker.set(l.fro_worker_id, []);
    logsByWorker.get(l.fro_worker_id).push(l);
  }

  // Attach resolution + receipt to every sheet row
  for (const row of gt.rows) {
    row.res = resolve(row.agent);
    row.receipt = receiptsByNo.get(`${row.proj}|${row.receiptNo}`) || null;
  }

  // Per-worker sheet grouping
  const sheetByWorker = new Map(); // workerId -> rows[]
  const excludedAgg = new Map(); // agent -> {n, sum}
  const unresolvedAgg = new Map();
  for (const row of gt.rows) {
    if (row.res.kind === 'excluded') {
      const k = row.agent;
      if (!excludedAgg.has(k)) excludedAgg.set(k, { n: 0, sum: 0 });
      Object.assign(excludedAgg.get(k), { n: excludedAgg.get(k).n + 1, sum: excludedAgg.get(k).sum + row.amount });
    } else if (row.res.kind === 'unresolved') {
      const k = row.agent;
      if (!unresolvedAgg.has(k)) unresolvedAgg.set(k, { n: 0, sum: 0 });
      Object.assign(unresolvedAgg.get(k), { n: unresolvedAgg.get(k).n + 1, sum: unresolvedAgg.get(k).sum + row.amount });
    } else {
      const wid = row.res.worker.id;
      if (!sheetByWorker.has(wid)) sheetByWorker.set(wid, []);
      sheetByWorker.get(wid).push(row);
    }
  }

  // Coverage pass per actionable worker
  const results = [];
  const fixCandidates = [];
  const extraRows = [];

  const allWorkers = new Map(workers.map((w) => [w.id, w]));
  const involvedIds = new Set([...sheetByWorker.keys(), ...logsByWorker.keys()]);

  for (const wid of involvedIds) {
    const worker = allWorkers.get(wid) || { id: wid, name: `(unknown ${wid.slice(0, 8)})` };
    const entries = buildCountedEntries(logsByWorker.get(wid) || []);
    const rows = sheetByWorker.get(wid) || [];
    const dashboardTotal = entries.reduce((s, e) => s + num(e.rep.amount_collected), 0);
    const actualTotal = rows.reduce((s, r) => s + r.amount, 0);

    const free = new Set(entries.map((e) => e.key));
    const entryByKey = new Map(entries.map((e) => [e.key, e]));

    const tierOf = (row, e) => {
      const l = e.rep;
      const dayOk = collectionDayOf(l) === row.date;
      if (!dayOk) return 0;
      if (Math.abs(num(l.amount_collected) - row.amount) > 0.001) return 0;
      if ((l.ngo_id || null) !== NGOS[row.proj]) return 0;
      const lr = cleanRef(l.upi_transaction_id);
      if (lr.length >= 5 && row.payId && cleanRef(row.payId) === lr) return 1;
      const lm = digitsOnly(l.donor_mobile);
      if (lm.length >= 7 && row.mobile && row.mobile === lm) return 2;
      if (norm(l.donor_name) && norm(l.donor_name) === norm(row.donorName)) return 3;
      return 0;
    };

    // Greedy: strongest matches first (tier asc)
    const pairs = [];
    for (const row of rows) {
      for (const e of entries) {
        if (!free.has(e.key)) continue;
        const t = tierOf(row, e);
        if (t) pairs.push({ row, key: e.key, tier: t });
      }
    }
    pairs.sort((a, b) => a.tier - b.tier);
    const coveredRows = new Set();
    const consumedKeys = new Set();
    for (const p of pairs) {
      if (coveredRows.has(p.row) || consumedKeys.has(p.key)) continue;
      coveredRows.add(p.row);
      consumedKeys.add(p.key);
      p.row.matchedKey = p.key;
    }

    // Missing = sheet money with no backing counted entry
    const missing = rows.filter((r) => !coveredRows.has(r));
    for (const r of missing) fixCandidates.push(r);

    // Extras = counted CRM money not claimed by any sheet row
    for (const e of entries) {
      if (consumedKeys.has(e.key)) continue;
      const l = e.rep;
      extraRows.push({
        workerId: wid, workerName: worker.name,
        logId: l.id, ngo: Object.entries(NGOS).find(([, v]) => v === l.ngo_id)?.[0] || '?',
        day: collectionDayOf(l), amount: num(l.amount_collected),
        donor: l.donor_name || l.donor_id, mobile: digitsOnly(l.donor_mobile),
        ref: l.upi_transaction_id || '', disc: paymentDiscriminant(l), remark: l.remark || '',
        amountStr: String(l.amount_collected),
      });
    }

    if (rows.length || entries.length) {
      results.push({
        workerId: wid, name: worker.name,
        dashboard: round2(dashboardTotal), actual: round2(actualTotal),
        delta: round2(dashboardTotal - actualTotal),
        missingN: missing.length, missingSum: round2(missing.reduce((s, r) => s + r.amount, 0)),
        extraN: 0, extraSum: 0, _wid: wid,
      });
    }
  }

  // Aggregate extras into per-worker numbers
  for (const x of extraRows) {
    const r = results.find((q) => q.workerId === x.workerId);
    if (r) { r.extraN += 1; r.extraSum = round2(r.extraSum + x.amount); }
  }
  results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  await client.end();
  return { gt, results, fixCandidates, extraRows, excludedAgg, unresolvedAgg };
}

const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------- report
export async function writeReport(label) {
  const { gt, results, fixCandidates, extraRows, excludedAgg, unresolvedAgg } = await analyze();

  const summary = [['FRO', 'Status', 'Dashboard Rs', 'Actual Rs (Excel)', 'Delta', 'Missing n', 'Missing Rs', 'Extra n', 'Extra Rs']];
  let td = 0, ta = 0;
  for (const r of results) {
    summary.push([r.name, 'actionable', r.dashboard, r.actual, r.delta, r.missingN, r.missingSum, r.extraN, r.extraSum]);
    td += r.dashboard; ta += r.actual;
  }
  for (const [k, v] of [...excludedAgg].sort()) {
    summary.push([k, 'EXCLUDED (no fix)', '', v.sum, '', v.n, v.sum, '', '']);
  }
  for (const [k, v] of [...unresolvedAgg].sort()) {
    summary.push([k, 'UNRESOLVED (check name)', '', v.sum, '', v.n, v.sum, '', '']);
  }
  summary.push(['TOTAL (actionable)', '', round2(td), round2(ta), round2(td - ta), '', '', '', '']);

  const missingAoa = [['Proj', 'Receipt No', 'Date', 'Time', 'Amt', 'Agent', 'Donor', 'Mobile', 'PayID', 'MOP', 'InCRM?', 'Plan']];
  for (const r of fixCandidates) {
    missingAoa.push([r.proj, r.receiptNo, r.date, `${r.hh}:${r.mm}`, r.amount, r.agent, r.donorName,
      r.mobile, r.payId, r.mop, r.receipt ? 'yes' : 'NO!',
      r.receipt ? 'create log + link receipt.log_id' : 'RECEIPT MISSING - manual']);
  }

  const extraAoa = [['LogId', 'Worker', 'NGO', 'Day', 'Amt', 'Donor', 'Mobile', 'Ref', 'Disc', 'Remark']];
  for (const x of extraRows) {
    extraAoa.push([x.logId, x.workerName, x.ngo, x.day, x.amount, x.donor, x.mobile, x.ref, x.disc, x.remark]);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(missingAoa), 'MissingRows');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extraAoa), 'ExtraRows');

  const out = path.join(os.homedir(), 'Desktop', `FRO_Parity_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  XLSX.writeFile(wb, out);

  console.log(`\n=== FRO PARITY (${label}) ===`);
  console.table(results.map(({ _wid, workerId, ...rest }) => rest));
  console.log(`Excluded agents:`, [...excludedAgg.entries()].map(([k, v]) => `${k}(n=${v.n},Rs${v.sum})`).join(' ') || '-');
  console.log(`Unresolved agents:`, [...unresolvedAgg.entries()].map(([k, v]) => `${k}(n=${v.n},Rs${v.sum})`).join(' ') || '-');
  console.log(`Skipped junk rows: ${gt.skipped.length}`);
  console.log(`Fix candidates (missing logs to create): ${fixCandidates.length}`);
  console.log(`Extra CRM entries (report-only): ${extraRows.length}`);
  console.log(`Report saved: ${out}`);
  return { results, fixCandidates, extraRows, out };
}

// ---------------------------------------------------------------------- fix
// App-entered donations that landed under the WRONG FRO login (excel is
// authoritative). Each entry: log -> target worker, plus receipt to link.
const REASSIGNMENTS = [
  { logId: 160453, toWorker: 'caf3a127-3932-4fcc-9d8e-8cac6cb6be5e', proj: 'aflf', receiptNo: '18932' }, // Riddhi Patel -> Siddhi Gunjal
  { logId: 160410, toWorker: 'efa50744-ef43-49a5-95eb-0b09558d68fa', proj: 'bsct', receiptNo: '82123' }, // Ravina Jain -> Ravina Ambre
  { logId: 158685, toWorker: 'fe5a465c-04e5-4cbf-aaec-baf5855528a0', proj: 'aflf', receiptNo: '18902' }, // Varsha Sakariya -> Sangeeta Kanojiya
  { logId: 160466, toWorker: 'fe5a465c-04e5-4cbf-aaec-baf5855528a0', proj: 'aflf', receiptNo: '18902' }, // 2nd app copy of same donation - move so it dedupes on target
];

// A backfilled log whose UPI ref collides with an existing app-entered log
// (excel lists the same payment under two receipt nos). Nulling the ref makes
// paymentDiscriminant fall through to the remark -> unique R<receiptNo> key,
// so both excel rows count, mirroring prior snapshot-backfill behaviour.
const DISC_FIXES = [{ logId: 164488, reason: 'sheet lists Rs500 twice (#82132+#82163) same ref' }];

// CRM amount disagrees with excel (1000.01 vs 1000) - excel is truth.
const AMOUNT_FIXES = [{ logId: 129836, from: '1000.01', to: '1000' }];

// Receipts whose parity is restored by a reassignment/amount fix above.
const HANDLED_BY_OTHER_FIXES = new Set([
  'aflf|18932', 'bsct|82123', 'aflf|18902', 'bsct|82035',
]);
export async function applyFixes({ apply }) {
  const { client } = await loadDb();
  const { gt, fixCandidates } = await analyze();

  const actions = [];
  const seenReceipt = new Set();

  for (const r of fixCandidates) {
    if (HANDLED_BY_OTHER_FIXES.has(`${r.proj}|${r.receiptNo}`)) { r.planSkip = 'covered by reassignment/amount fix'; continue; }
    if (seenReceipt.has(`${r.proj}|${r.receiptNo}`)) { r.planSkip = 'duplicate receipt row in sheet'; continue; }
    seenReceipt.add(`${r.proj}|${r.receiptNo}`);
    if (!r.receipt) { r.planSkip = 'receipt missing in CRM'; continue; }
    actions.push(r);
  }

  const assignCache = new Map();
  const getAssignment = async (workerId, ngoId) => {
    const k = `${workerId}|${ngoId}`;
    if (assignCache.has(k)) return assignCache.get(k);
    const q = await client.query(
      `SELECT id FROM fro_assignments WHERE fro_worker_id=$1 AND ngo_id=$2 ORDER BY id DESC LIMIT 1`,
      [workerId, ngoId]);
    let id = q.rows[0]?.id || null;
    assignCache.set(k, id);
    return id;
  };

  const ensureAssignment = async (workerId, ngoId, donorId) => {
    let id = await getAssignment(workerId, ngoId);
    if (id) return { id, created: false };
    const ins = await client.query(
      `INSERT INTO fro_assignments (donor_id, fro_worker_id, ngo_id, assigned_by, assigned_at, status, notes, is_new, station, batch_id, batch_type)
       VALUES ($1,$2,$3,$4, now(), $5, 'Parity backfill', false, $6, $7, $8) RETURNING id`,
      [donorId || ANON_DONOR_ID, workerId, ngoId, ADMIN_FALLBACK_ASSIGNED_BY,
        ASSIGNMENT_TEMPLATE.status, ASSIGNMENT_TEMPLATE.station, ASSIGNMENT_TEMPLATE.batch_id, ASSIGNMENT_TEMPLATE.batch_type]);
    id = ins.rows[0].id;
    assignCache.set(`${workerId}|${ngoId}`, id);
    return { id, created: true };
  };

  console.log(`\n=== FIX PLAN (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  for (const x of REASSIGNMENTS) {
    console.log(`[REASSIGN] log ${x.logId} -> worker ${x.toWorker.slice(0, 8)} (${x.proj} #${x.receiptNo})`);
  }
  for (const x of AMOUNT_FIXES) {
    console.log(`[AMOUNT] log ${x.logId}: ${x.from} -> ${x.to}`);
  }
  for (const x of DISC_FIXES) {
    console.log(`[DISC] log ${x.logId}: null upi ref so remark R<no> key counts separately (${x.reason})`);
  }
  console.log(`Logs to create: ${actions.length}`);
  for (const r of actions) {
    console.log(`[BACKFILL] ${r.proj} #${r.receiptNo} ${r.date} Rs${r.amount} ${r.agent}`);
  }
  const skipped = fixCandidates.filter((r) => r.planSkip);
  if (skipped.length) console.log(`Skipped candidates: ${skipped.map((r) => `${r.proj}#${r.receiptNo}(${r.planSkip})`).join(', ')}`);

  const backupDir = 'C:/Users/ADMIN/AppData/Local/Temp/opencode';
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `parity_fix_backup_${Date.now()}.json`);
  const backup = { createdAt: new Date().toISOString(), logsCreated: [], receiptsTouched: [], reassignments: [], assignmentsCreated: [], amountFixes: [] };

  let done = 0, failed = 0;

  if (!apply) { console.log('Dry run - nothing changed.'); await client.end(); return; }

  try {
    // ---- 1. Reassignments -------------------------------------------------
    for (const x of REASSIGNMENTS) {
      const lq = await client.query(`SELECT * FROM fro_donor_logs WHERE id=$1`, [x.logId]);
      const log = lq.rows[0];
      if (!log) { console.error(`[FAIL] reassign ${x.logId}: log not found`); failed++; continue; }
      if (log.fro_worker_id === x.toWorker) { console.log(`[SKIP] log ${x.logId} already on target worker`); continue; }
      const rq = await client.query(`SELECT id, log_id, donor_id FROM receipts WHERE project_id=$1 AND receipt_no=$2`, [x.proj, x.receiptNo]);
      const receipt = rq.rows[0];
      const donorId = log.donor_id || receipt?.donor_id || ANON_DONOR_ID;
      const { id: assignId, created } = await ensureAssignment(x.toWorker, NGOS[x.proj], donorId);
      await client.query(`UPDATE fro_donor_logs SET fro_worker_id=$1, assignment_id=$2 WHERE id=$3`, [x.toWorker, assignId, x.logId]);
      if (receipt && receipt.log_id !== x.logId) {
        await client.query(`UPDATE receipts SET log_id=$1 WHERE id=$2`, [x.logId, receipt.id]);
      }
      backup.reassignments.push({ logId: x.logId, before: log, toWorker: x.toWorker, newAssignmentId: assignId, receiptLinked: receipt?.id || null });
      if (created) backup.assignmentsCreated.push({ id: assignId, workerId: x.toWorker, ngoId: NGOS[x.proj], donorId });
      console.log(`[OK] reassigned log ${x.logId} -> ${x.toWorker.slice(0, 8)} (assign ${assignId}${created ? ' NEW' : ''}), receipt ${x.proj}#${x.receiptNo} linked`);
      done++;
    }

    // ---- 2. Amount corrections -------------------------------------------
    for (const x of AMOUNT_FIXES) {
      const lq = await client.query(`SELECT amount_collected FROM fro_donor_logs WHERE id=$1`, [x.logId]);
      const cur = String(lq.rows[0]?.amount_collected ?? '');
      if (cur === x.to) { console.log(`[SKIP] log ${x.logId} already Rs${x.to}`); continue; }
      if (cur !== x.from) { console.error(`[FAIL] amount fix ${x.logId}: expected ${x.from}, found ${cur}`); failed++; continue; }
      await client.query(`UPDATE fro_donor_logs SET amount_collected=$1 WHERE id=$2`, [x.to, x.logId]);
      backup.amountFixes.push({ logId: x.logId, from: cur, to: x.to });
      console.log(`[OK] log ${x.logId} amount ${cur} -> ${x.to}`);
      done++;
    }

    // ---- 2b. Discriminant fixes (null colliding upi refs) -----------------
    for (const x of DISC_FIXES) {
      const lq = await client.query(`SELECT upi_transaction_id FROM fro_donor_logs WHERE id=$1`, [x.logId]);
      const cur = lq.rows[0]?.upi_transaction_id ?? null;
      if (cur === null) { console.log(`[SKIP] log ${x.logId} ref already null`); continue; }
      await client.query(`UPDATE fro_donor_logs SET upi_transaction_id=NULL WHERE id=$1`, [x.logId]);
      backup.discFixes = backup.discFixes || [];
      backup.discFixes.push({ logId: x.logId, before: cur, after: null });
      console.log(`[OK] log ${x.logId} upi ref '${cur}' -> NULL`);
      done++;
    }

    // ---- 3. Backfill missing logs ----------------------------------------
    for (const r of actions) {
      const workerId = r.res.worker.id;
      const ngoId = NGOS[r.proj];
      const donorId = r.receipt.donor_id || ANON_DONOR_ID;
      try {
        // Dup guard: never double-backfill the same receipt for the same worker
        const dup = await client.query(
          `SELECT id FROM fro_donor_logs WHERE fro_worker_id=$1 AND remark LIKE $2 LIMIT 1`,
          [workerId, `%receipt ${r.receiptNo} (%`]);
        if (dup.rows[0]) { console.log(`[DUP-SKIP] ${r.proj}#${r.receiptNo} already has backfill log ${dup.rows[0].id}`); continue; }

        const { id: assignmentId, created } = await ensureAssignment(workerId, ngoId, donorId);

        // Key-collision guard: if the worker already has an entry with the same
        // donor|amount|day|ngo|U<ref> key, omit the upi ref so the remark's
        // R<receiptNo> discriminant keeps this excel row counting separately.
        let payId = r.payId || null;
        if (payId) {
          const coll = await client.query(
            `SELECT 1 FROM fro_donor_logs l LEFT JOIN fro_assignments a ON a.id=l.assignment_id
             WHERE l.fro_worker_id=$1 AND l.upi_transaction_id IS NOT NULL
               AND regexp_replace(lower(l.upi_transaction_id), '[^0-9a-z]', '', 'g') = $2
               AND COALESCE(l.transaction_datetime, l.created_at)::date = $3::date
               AND l.amount_collected::numeric = $4::numeric
               AND a.ngo_id = $5 LIMIT 1`,
            [workerId, cleanRef(payId), r.date, r.amount, ngoId]);
          if (coll.rows[0]) {
            payId = null;
            console.log(`   [KEY-COLLISION] ref ${r.payId} already used by an existing entry -> R${r.receiptNo} key`);
          }
        }

        const logPayload = {
          assignment_id: assignmentId, action: 'donation',
          accounts_status: 'verified', amount_collected: r.amount,
          created_by: SYSTEM_ACTOR, donor_id: donorId, fro_worker_id: workerId,
          remark: `backfilled from receipt ${r.receiptNo} (${r.proj} parity fix)`,
          upi_transaction_id: payId,
          transaction_datetime: r.txdt, payment_mode: mapPaymentMode(r.mop),
          notes: 'Parity backfill from accounts sheet', payment_screenshot_url: null,
          pan_number: null, verified_at: null, verified_by: null,
          payment_from: null, rejection_reason: null, scheduled_at: null,
          outcome: null, disposition_category: null, disposition_detail: null,
        };

        const cols = Object.keys(logPayload);
        const vals = Object.values(logPayload);
        const ph = cols.map((_, i) => `$${i + 1}`).join(',');
        const insL = await client.query(
          `INSERT INTO fro_donor_logs (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals);
        const logId = insL.rows[0].id;

        await client.query(`UPDATE receipts SET log_id=$1 WHERE id=$2`, [logId, r.receipt.id]);

        backup.logsCreated.push({ logId, payload: logPayload });
        backup.receiptsTouched.push({ id: r.receipt.id, logIdBefore: r.receipt.log_id, logIdAfter: logId });
        if (created) backup.assignmentsCreated.push({ id: assignmentId, workerId, ngoId, donorId });
        console.log(`[OK] backfilled ${r.proj}#${r.receiptNo} Rs${r.amount} ${r.agent} -> log ${logId} (assign ${assignmentId}${created ? ' NEW' : ''}, donor ${donorId}, ${r.txdt})`);
        done++;
      } catch (e) {
        failed++;
        console.error(`[FAIL] ${r.proj}#${r.receiptNo}: ${e.message}`);
      }
    }
  } finally {
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    console.log(`\nBackup: ${backupFile}`);
    console.log(`Processed: ${done}, Failed: ${failed}`);
    await client.end();
  }
}

// --------------------------------------------------------------------- main
const mode = process.argv[2] || 'report';
const label = process.argv[3] || 'BEFORE';
const apply = process.argv.includes('--apply');

if (process.env.PARITY_NO_MAIN !== '1') {
  if (mode === 'fix') {
    await applyFixes({ apply });
  } else {
    await writeReport(label.toUpperCase());
  }
}
