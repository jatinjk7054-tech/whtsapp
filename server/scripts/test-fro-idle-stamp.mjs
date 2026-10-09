// Regression: stamping idle when the window lapses must not double count.
// Run: node scripts/test-fro-idle-stamp.mjs
//
// The reported symptom: the strip showed ~199 min of idle for an FRO while the
// stored today_idle_seconds was still 0. The deadline had lapsed hours earlier
// and no status push had ever run, so idle_since was still NULL and the stretch
// was only being *derived* from the deadline on read. Every reader of the stored
// column (NGO-admin board, fro_daily_stats, the monthly salary total) therefore
// disagreed with the strip.
//
// stampLapsedIdle closes that gap by writing idle_since = disposition_due_at.
// The risk that introduces is double counting, because a committed total plus a
// stamp is the same shape as a committed total plus a still-open period. These
// cases pin the arithmetic: the derived figure must be identical before and
// after the stamp, and the eventual commit must bank exactly that once.
import { liveIdleSeconds, idlePeriodStartMs, commitIdle, istDateStr, withoutStaleIdle, withinShift, isIdleNow } from '../src/utils/froIdle.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const IST_OFFSET = 5.5 * 3600 * 1000;
const istNow = (h, m = 0) => {
  const utcMidnight = Date.UTC(2026, 8, 28);
  return utcMidnight - IST_OFFSET + (h * 3600 + m * 60) * 1000;
};

const MIN = 60 * 1000;
const shift = { startMs: istNow(10), endMs: istNow(19) };

// The production shape: deadline lapsed at 10:42 IST, never stamped, read at
// 13:32 IST, stored total still 0.
const lapsedAt = istNow(10, 42);
const readAt = istNow(13, 32);
const row = {
  today_idle_seconds: 0,
  idle_since: null,
  disposition_due_at: new Date(lapsedAt).toISOString(),
  is_paused: false,
  status: 'online',
};

// 1. Before the stamp the stretch is derived from the deadline.
const before = liveIdleSeconds(row, shift, readAt);
check('a lapsed unstamped deadline derives the elapsed idle', before, 170 * 60);

// 2. The stamp lands exactly where the derivation already began, so the number
//    on screen cannot move when the row is settled.
const stamped = { ...row, idle_since: row.disposition_due_at, status: 'idle' };
check('stamping does not change the derived total', liveIdleSeconds(stamped, shift, readAt), before);

// 3. The period is a real open period after stamping, so the resume /
//    disposition-save path still banks it.
check('the stamped period is open', Number.isFinite(idlePeriodStartMs(stamped, readAt)), true);
check('the FRO is idle', isIdleNow(stamped, shift, readAt), true);

// 4. Committing banks it once. If the stamp had started the period anywhere
//    else — or if the deadline were left behind to be derived again — this total
//    would exceed what was on screen.
const banked = commitIdle(stamped, shift, readAt);
check('the commit banks the same span that was displayed', banked, before);

// 5. After committing, the row is settled: committed total carries the time and
//    nothing is still open, so a later read does not add it a second time.
const settled = { today_idle_seconds: banked, idle_since: null, disposition_due_at: null, is_paused: false, status: 'online' };
check('a settled row reads back the same total', liveIdleSeconds(settled, shift, readAt), before);
check('a settled row has no open period', Number.isFinite(idlePeriodStartMs(settled, readAt)), false);

// 6. A committed stretch already banked earlier must not be re-opened by the
//    deadline that produced it. idle_since wins over disposition_due_at, so the
//    open period runs from the stamp (11:05) and not the deadline (11:09).
const earlier = {
  today_idle_seconds: 22 * 60,
  idle_since: new Date(istNow(11, 5)).toISOString(),
  disposition_due_at: new Date(istNow(11, 9)).toISOString(),
  is_paused: false,
  status: 'idle',
};
check('the stamp takes precedence over the deadline', idlePeriodStartMs(earlier, istNow(11, 12)), istNow(11, 5));
check('banked time plus the running stretch', liveIdleSeconds(earlier, shift, istNow(11, 12)), (22 * 60) + 7 * 60);

// 7. A deadline that has not lapsed is left alone — no stamp, no idle.
const pending = {
  today_idle_seconds: 0,
  idle_since: null,
  disposition_due_at: new Date(istNow(13, 35)).toISOString(),
  is_paused: false,
  status: 'online',
};
check('a pending deadline is not idle', isIdleNow(pending, shift, readAt), false);
check('a pending deadline derives no open period', Number.isFinite(idlePeriodStartMs(pending, readAt)), false);

// 8. Outside the shift nothing is stamped, so nobody is billed for sitting
//    idle after hours.
const afterHours = { ...row, disposition_due_at: new Date(istNow(20, 30)).toISOString() };
const nightShift = { startMs: istNow(10), endMs: istNow(19) };
check('no idle after the shift ends', withinShift(nightShift, istNow(20, 45)), false);
check('after-hours idle is not counted', liveIdleSeconds(afterHours, nightShift, istNow(20, 45)), 0);

// 9. Yesterday's deadline stays stale and is dropped, so the stamp cannot revive
//    it as today's idle.
const yesterday = {
  today_idle_seconds: 0,
  idle_since: null,
  disposition_due_at: new Date(istNow(9, 30) - 24 * 60 * 60 * 1000).toISOString(),
  is_paused: false,
  status: 'idle',
};
check('a previous-day deadline has no open period', Number.isFinite(idlePeriodStartMs(yesterday, istNow(10, 0))), false);
check('a previous-day deadline reads as no idle', liveIdleSeconds(yesterday, shift, istNow(10, 0)), 0);

console.log(failed === 0 ? '\nAll stamp tests passed.' : `\n${failed} stamp test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
