// READ-ONLY diagnostic for one FRO's disposition-timer state. Writes nothing.
//
// Run on a host that can reach the database:
//   node scripts/inspect-fro-worker.mjs "Mahima Redkar"
//
// It prints the raw live row, the attendance rows the shift window is derived
// from, and what each reader (getMyLiveStatus, updateLiveStatus, the client)
// would conclude — so the "timer resets on refresh" question can be answered
// from data instead of by reading code and guessing.
import 'dotenv/config';
import pg from 'pg';
import {
  getShiftWindowMs, withoutStaleIdle, isIdleNow, dispositionDueMs,
  nextDeadline, istDateStr, withinShift, liveIdleSeconds,
} from '../src/utils/froIdle.js';

const wanted = (process.argv[2] || 'Mahima').trim();
const url = process.env.DATABASE_URL;
if (!url) { console.log('no DATABASE_URL'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const nowMs = Date.now();
const show = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'null');

console.log(`now (UTC)   = ${show(nowMs)}`);
console.log(`now (IST)   = ${new Date(nowMs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
console.log(`IST day     = ${istDateStr(new Date(nowMs))}`);
console.log(`filter      = ${wanted}\n`);

const { rows: workers } = await client.query(
  `SELECT id, name, login_id, department, is_active
     FROM workers
    WHERE name ILIKE $1 OR login_id ILIKE $1
    ORDER BY name`,
  [`%${wanted}%`]
);

if (!workers.length) {
  console.log(`no worker matching "${wanted}"`);
  await client.end();
  process.exit(0);
}

const { rows: lives } = await client.query(
  `SELECT * FROM fro_live_status
    WHERE worker_id = ANY($1::uuid[])`,
  [workers.map((w) => w.id)]
);
const liveBy = new Map(lives.map((r) => [r.worker_id, r]));

for (const w of workers) {
  console.log('='.repeat(72));
  console.log(`${w.name}  (${w.id})  login=${w.login_id || '-'}  dept=${w.department}  active=${w.is_active}`);

  const row = liveBy.get(w.id) || null;
  if (!row) {
    console.log('  NO fro_live_status ROW — the panel will show "Not started".');
    console.log('  A non-disposition action would open a fresh 4:00 window.\n');
    continue;
  }

  console.log('  -- raw row --');
  for (const k of ['status', 'is_paused', 'disposition_due_at', 'idle_since', 'today_idle_seconds', 'today_calls', 'today_talk_seconds', 'updated_at', 'work_as_operator_id']) {
    if (k in row) console.log(`     ${k.padEnd(20)} = ${row[k] === null ? 'null' : row[k]}`);
  }

  const shift = await getShiftWindowMs(w.id, nowMs);
  console.log('  -- shift window (what the server resolves NOW) --');
  console.log(`     start = ${show(shift.startMs)}   end = ${show(shift.endMs)}`);
  console.log(`     inShift = ${withinShift(shift, nowMs)}`);

  const { rows: att } = await client.query(
    `SELECT punch_in_time, punch_out_time FROM attendance
      WHERE worker_id = $1 AND punch_in_time >= $2::timestamptz - interval '2 days'
      ORDER BY punch_in_time DESC LIMIT 6`,
    [w.id, new Date(nowMs).toISOString()]
  );
  console.log('  -- recent attendance (this window is the thing that moves) --');
  if (!att.length) console.log('     (no attendance rows in the last 2 days -> configured office hours are used)');
  for (const a of att) {
    console.log(`     punch_in_time=${a.punch_in_time || '-'}  punch_out_time=${a.punch_out_time || '-'}`);
  }

  const dueMs = dispositionDueMs(row);
  const cleaned = withoutStaleIdle(row, shift, nowMs);
  const cleanedDue = dispositionDueMs(cleaned);
  const secondsLeft = (d) => (Number.isFinite(d) ? Math.max(0, Math.round((d - nowMs) / 1000)) : null);

  console.log('  -- what each reader concludes --');
  console.log(`     deadline (ms)          = ${show(dueMs)}   expired = ${Number.isFinite(dueMs) ? dueMs < nowMs : 'n/a'}`);
  console.log(`     withoutStaleIdle drops it? = ${cleaned.disposition_due_at === null && row.disposition_due_at !== null}`);
  console.log(`     isIdleNow                = ${isIdleNow(row, shift, nowMs)}`);
  console.log(`     liveIdleSeconds (total)  = ${liveIdleSeconds(row, shift, nowMs)}`);
  console.log('  -- what the client is told on refresh (GET /fro/status/me) --');
  const servedDue = cleaned.disposition_due_at || null;
  console.log(`     disposition_due_at      = ${servedDue || 'null'}`);
  console.log(`     seconds_left            = ${secondsLeft(Number.isFinite(cleanedDue) ? cleanedDue : NaN)}`);
  console.log(`     is_idle                 = ${isIdleNow(cleaned, shift, nowMs)}`);
  console.log(`     in_shift                = ${withinShift(shift, nowMs)}`);

  const workedToday = Number(row.today_calls || 0) > 0 || Number(row.today_talk_seconds || 0) > 0;
  const arming = !row.disposition_due_at && !workedToday;
  console.log('  -- would the next action re-arm a fresh 4:00? --');
  console.log(`     today_calls=${row.today_calls ?? 0} today_talk_seconds=${row.today_talk_seconds ?? 0} → workedToday=${workedToday}`);
  console.log(`     arming = ${arming}${arming ? '   <-- a non-disposition action HANDS OUT A NEW 4 MINUTES' : ''}`);
  if (!arming) {
    const nd = nextDeadline(shift, nowMs);
    console.log(`     (for reference, a disposition right now would set the deadline to ${show(nd)})`);
  }
  console.log('');
}

await client.end();
