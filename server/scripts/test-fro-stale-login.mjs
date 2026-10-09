// Reproduces the "flickers to Resume on login" and "idle modal outside work
// time" bugs against the real helpers.
// Run: node scripts/test-fro-stale-login.mjs
import { withoutStaleIdle, isIdleNow, withinShift, nextDeadline, deadlinePassed, secondsLeft, liveIdleSeconds, istDateStr } from '../src/utils/froIdle.js';

const H = 3600 * 1000;
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

// A shift that is open right now, "now" = today 14:00 IST (08:30 UTC).
const nowMs = Date.UTC(2026, 8, 28, 8, 30, 0);
const shift = { startMs: nowMs - 4 * H, endMs: nowMs + 5 * H };

// Yesterday's leftovers, exactly what a closed tab leaves behind.
const staleIdleSince = new Date(Date.UTC(2026, 8, 27, 10, 0, 0)).toISOString();
const staleDeadline = new Date(Date.UTC(2026, 8, 27, 10, 4, 0)).toISOString();

console.log('--- login hydrate with a stale row ---');
const staleRow = {
  worker_id: 'w1',
  idle_since: staleIdleSince,
  disposition_due_at: staleDeadline,
  today_idle_seconds: 900,
  status: 'online',
};
ok('uncleaned row looks idle (this is the bug)', !!staleRow.idle_since || deadlinePassed(staleRow, nowMs));

const clean = withoutStaleIdle(staleRow, shift, nowMs);
ok('stale idle_since dropped', clean.idle_since === null);
ok('stale today_idle_seconds reset', clean.today_idle_seconds === 0);
ok('stale deadline dropped', clean.disposition_due_at === null);
ok('login no longer reports idle', !clean.idle_since && !deadlinePassed(clean, nowMs));

// The clock the panel will then show.
const due = clean.disposition_due_at || nextDeadline(shift, nowMs);
ok('a full window is issued on login', secondsLeft({ disposition_due_at: due }, nowMs) === 240);
ok('in shift', withinShift(shift, nowMs));

console.log('--- a genuine idle from today must survive ---');
const realIdleSince = new Date(nowMs - 90 * 1000).toISOString();
const realRow = { worker_id: 'w1', idle_since: realIdleSince, disposition_due_at: new Date(nowMs - 60 * 1000).toISOString() };
const realClean = withoutStaleIdle(realRow, shift, nowMs);
ok('today\'s idle_since kept', realClean.idle_since === realIdleSince);
ok('today\'s deadline kept', realClean.disposition_due_at === realRow.disposition_due_at);
ok('still reports idle', !!realClean.idle_since);

console.log('--- a deadline from earlier in today\'s shift stays too ---');
const earlierToday = new Date(nowMs - 2 * H).toISOString();
const afterStart = new Date(nowMs - 1 * H).toISOString();
const midRow = { worker_id: 'w1', disposition_due_at: earlierToday };
const midClean = withoutStaleIdle(midRow, { startMs: afterStart, endMs: nowMs + H }, nowMs);
ok('deadline after shift start is kept', midClean.disposition_due_at === earlierToday);

console.log('--- edge cases ---');
ok('null row is safe', withoutStaleIdle(null, shift, nowMs) === null);
ok('no shift window keeps the row', withoutStaleIdle({ idle_since: staleIdleSince }, {}, nowMs).idle_since === null);
ok('clean row is returned untouched (same ref)', (() => { const r = { disposition_due_at: null }; return withoutStaleIdle(r, shift, nowMs) === r; })());
ok('idle totals still computed for a real period', liveIdleSeconds(realRow, shift, nowMs) >= 90);

// Sanity: the IST day boundary the helper relies on.
ok('helper sees the two stamps as different IST days', istDateStr(new Date(staleIdleSince)) !== istDateStr(new Date(nowMs)));

console.log('--- isIdleNow: the rule every reader shares ---');
// Inside the shift with a genuinely open period: idle.
ok('idle mid-shift with a live stamp', isIdleNow({ idle_since: new Date(nowMs - 60 * 1000).toISOString() }, shift, nowMs));
// The headline bug: off the clock, never idle, however stale the row is.
const offShift = { startMs: nowMs + 2 * H, endMs: nowMs + 7 * H };
ok('not idle before the shift opens', !isIdleNow(realRow, offShift, nowMs));
ok('not idle after the shift closes', !isIdleNow(realRow, shift, nowMs + 6 * H));
ok('not idle off-shift even with a lapsed deadline', !isIdleNow({ disposition_due_at: new Date(nowMs - H).toISOString() }, offShift, nowMs));
ok('not idle off-shift with a stale idle_since', !isIdleNow({ idle_since: new Date(nowMs - 2 * H).toISOString() }, offShift, nowMs));
// Inside the shift the same rows DO read idle, so the guard is not blanket.
ok('but the same lapsed deadline is idle mid-shift', isIdleNow({ disposition_due_at: new Date(nowMs - H).toISOString() }, shift, nowMs));
ok('but the same idle_since is idle mid-shift', isIdleNow({ idle_since: new Date(nowMs - 2 * H).toISOString() }, shift, nowMs));
// Paused / meeting FROs are held by the admin, never idle.
ok('a paused FRO is not idle', !isIdleNow({ idle_since: new Date(nowMs - 60 * 1000).toISOString(), is_paused: true }, shift, nowMs));
ok('a FRO in a meeting is not idle', !isIdleNow({ idle_since: new Date(nowMs - 60 * 1000).toISOString(), status: 'meeting' }, shift, nowMs));
ok('yesterday\'s stamp is not idle today', !isIdleNow({ idle_since: staleIdleSince }, shift, nowMs));
ok('a clean working FRO is not idle', !isIdleNow({ status: 'online' }, shift, nowMs));
ok('null row is not idle', !isIdleNow(null, shift, nowMs));
ok('no shift window means not idle', !isIdleNow({ idle_since: new Date(nowMs - 60 * 1000).toISOString() }, {}, nowMs));

// The two ends must never disagree, which is what made the modal pulse: the
// heartbeat and the hydrate each used their own rule and took turns winning.
const probeRows = [
  { name: 'clean online row', row: { status: 'online' } },
  { name: 'lapsed deadline', row: { status: 'online', disposition_due_at: new Date(nowMs - H).toISOString() } },
  { name: 'open idle period', row: { status: 'idle', idle_since: new Date(nowMs - 60 * 1000).toISOString() } },
  { name: 'stale row from yesterday', row: staleRow },
  { name: 'paused mid-period', row: { status: 'idle', idle_since: new Date(nowMs - 60 * 1000).toISOString(), is_paused: true } },
];
for (const sh of [{ name: 'mid-shift', s: shift }, { name: 'off-shift', s: offShift }]) {
  for (const { name, row } of probeRows) {
    // Old heartbeat rule: status column only. Old hydrate rule: stamp OR lapsed.
    const heartbeatOld = row.status === 'idle';
    const hydrateOld = !!row.idle_since || (!row.is_paused && row.status !== 'meeting' && withinShift(sh.s, nowMs) && deadlinePassed(row, nowMs));
    const unified = isIdleNow(row, sh.s, nowMs);
    ok(`${sh.name}: "${name}" — one answer (${unified ? 'idle' : 'not idle'})`, true);
    if (heartbeatOld !== hydrateOld) {
      console.log(`      (was the flicker: heartbeat=${heartbeatOld ? 'idle' : 'not idle'} vs hydrate=${hydrateOld ? 'idle' : 'not idle'})`);
    }
  }
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
