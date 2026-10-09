// Regression: the 4-minute window must never rewind on its own.
// Run: node scripts/test-fro-timer-rewind.mjs
//
// The reported symptom: an FRO waits for the timer to reach 0:00 and it jumps
// back to 4:00 by itself. Two server rules used to hand out that free window,
// and both are exercised here.
//
//  1. withoutStaleIdle nulled a deadline that was merely EXPIRED whenever it sat
//     before the currently-resolved shift start. The shift window is resolved
//     from attendance with a configured fallback, so it moves between calls —
//     nulling the deadline and letting the next action re-arm a fresh 4:00.
//  2. "arming" meant "no deadline right now", not "first action of the day", so
//     any unrelated action after expiry re-armed the window.
import { withoutStaleIdle, dispositionDueMs, istDateStr, withinShift, isIdleNow } from '../src/utils/froIdle.js';

let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

// Build an IST "today" around a fixed clock so the day comparison is stable.
// IST is UTC+5:30, so IST midnight is 18:30 UTC on the previous calendar day.
const IST_OFFSET = 5.5 * 3600 * 1000;
const istNow = (h, m = 0) => {
  const utcMidnight = Date.UTC(2026, 8, 28);
  return utcMidnight - IST_OFFSET + (h * 3600 + m * 60) * 1000;
};
const nowMs = istNow(14, 0);

console.log('--- 1. an EXPIRED deadline from today must survive ---');
// She armed at 10:00, so the window closed at 10:04. It is now 14:00.
const expiredToday = {
  idle_since: null,
  disposition_due_at: new Date(istNow(10, 4)).toISOString(),
  today_calls: 3,
  today_talk_seconds: 900,
};
// The window we happen to resolve now starts LATER than her deadline — exactly
// what happens when attendance is read differently on two calls.
const lateWindow = { startMs: istNow(12, 0), endMs: istNow(20, 0) };
const kept = withoutStaleIdle(expiredToday, lateWindow, nowMs);
check('today\'s expired deadline is NOT nulled', kept.disposition_due_at, expiredToday.disposition_due_at);
check('and it still reads as expired', dispositionDueMs(kept) < nowMs, true);

// If it HAD been nulled, the next non-disposition action would re-arm 240s. This
// is the rewind the FRO saw.
console.log('\n--- 1b. yesterday\'s deadline is still cleaned up ---');
const yesterday = {
  idle_since: new Date(nowMs - 26 * 3600 * 1000).toISOString(),
  disposition_due_at: new Date(nowMs - 26 * 3600 * 1000).toISOString(),
  today_idle_seconds: 480,
};
const wiped = withoutStaleIdle(yesterday, lateWindow, nowMs);
check('yesterday\'s deadline dropped', wiped.disposition_due_at, null);
check('yesterday\'s idle_since dropped', wiped.idle_since, null);
check('yesterday\'s idle total reset', wiped.today_idle_seconds, 0);

console.log('\n--- 2. expiry keeps reading idle, it does not become "not started" ---');
const shift = { startMs: istNow(9, 0), endMs: istNow(18, 0) };
check('in shift', withinShift(shift, nowMs), true);
check('expired window = idle', isIdleNow(kept, shift, nowMs), true);
check('same row off shift = not idle', isIdleNow(kept, { startMs: istNow(20, 0), endMs: istNow(23, 0) }, nowMs), false);

console.log('\n--- 3. "first action of the day" must be day-scoped, not deadline-scoped ---');
// Mirrors the arming rule in createDonorLogHandler.
const arming = (row) => !row.disposition_due_at
  && !(Number(row.today_calls || 0) > 0 || Number(row.today_talk_seconds || 0) > 0);

const freshMorning = { disposition_due_at: null, today_calls: 0, today_talk_seconds: 0 };
check('genuinely no work today -> window opens', arming(freshMorning), true);

const workedThenExpired = {
  disposition_due_at: new Date(istNow(10, 4)).toISOString(),
  today_calls: 3,
  today_talk_seconds: 900,
};
check('expired but worked today -> no free re-arm', arming(workedThenExpired), false);

// The deadline got cleaned up mid-day, but they have worked: still no re-arm.
const workedDeadlineCleared = { disposition_due_at: null, today_calls: 2, today_talk_seconds: 60 };
check('deadline cleared mid-day but worked -> no re-arm', arming(workedDeadlineCleared), false);

console.log('\n--- 4. an expired window does not become a fresh 4:00 on read ---');
// seconds_left for an expired deadline is 0, never 240.
const secondsLeft = (row, at) => {
  const due = dispositionDueMs(row);
  if (!Number.isFinite(due)) return null;
  return Math.max(0, Math.round((due - at) / 1000));
};
check('expired window reads 0, not 240', secondsLeft(kept, nowMs), 0);
const rearmed = { disposition_due_at: new Date(nowMs + 240_000).toISOString() };
check('a real disposition reset reads 240', secondsLeft(rearmed, nowMs), 240);

console.log('\n--- 5. the day boundary is what makes a deadline stale ---');
const lateLastNight = { disposition_due_at: new Date(istNow(23, 50)).toISOString(), today_calls: 5 };
// Read 15 minutes later, same IST day: an expired-but-today window must stand,
// otherwise crossing midnight would be the same rewind bug in a different hat.
check('23:50 deadline survives a 23:55 read',
  withoutStaleIdle(lateLastNight, shift, istNow(23, 55)).disposition_due_at,
  lateLastNight.disposition_due_at);
// Past midnight it genuinely belongs to a finished day, so dropping it is right —
// otherwise the FRO would be forced idle the instant they open the new day.
check('23:50 deadline IS dropped at 00:05 next day',
  withoutStaleIdle(lateLastNight, shift, istNow(24, 5)).disposition_due_at,
  null);
check('a deadline from the day before is dropped',
  withoutStaleIdle({ disposition_due_at: new Date(istNow(23, 50) - 26 * 3600 * 1000).toISOString() }, shift, istNow(0, 5)).disposition_due_at,
  null);
check('same IST day both sides', istDateStr(new Date(istNow(23, 50))), istDateStr(new Date(istNow(23, 55))));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
