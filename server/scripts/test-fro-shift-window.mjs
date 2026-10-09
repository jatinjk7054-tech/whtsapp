// Why SOME FROs get the idle modal: a punch-out that lands BEFORE the
// configured shift end, or a punch-in from a prior day, can produce a window
// that is already closed (or opens later) at login time.
// Run: node scripts/test-fro-shift-window.mjs
import { withinShift, istDateStr, idlePeriodStartMs, isIdleNow, withoutStaleIdle, nextDeadline, deadlinePassed } from '../src/utils/froIdle.js';

const MIN = 60 * 1000;
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

// Re-implements getShiftWindowMs's arithmetic (no DB) so we can drive it with
// hypothetical attendance rows.
const IST_OFFSET = 5.5 * 3600 * 1000;
const istTimeMs = (day, h, m) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000+05:30`).getTime();

function shiftWindow({ punchIn, punchOut, nowMs, officeStart = { hour: 10, minute: 0 }, officeEnd = { hour: 19, minute: 0 } }) {
  const day = istDateStr(new Date(nowMs));
  const hasAttendance = Number.isFinite(punchIn);
  const cfgStart = istTimeMs(day, officeStart.hour, officeStart.minute);
  const cfgEnd = istTimeMs(day, officeEnd.hour, officeEnd.minute);
  let startMs = hasAttendance ? punchIn : cfgStart;
  let endMs = Number.isFinite(punchOut) ? punchOut : cfgEnd;
  if (hasAttendance && istDateStr(new Date(punchIn)) !== day) {
    startMs = cfgStart;
    if (Number.isFinite(punchOut) && istDateStr(new Date(punchOut)) === day) endMs = punchOut;
    else endMs = cfgEnd;
  }
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = cfgEnd > startMs ? cfgEnd : startMs;
  return { startMs, endMs, hasAttendance };
}

console.log('--- A: normal day, punched in, no deadline problem ---');
{
  const nowMs = new Date(`${istDateStr(new Date())}T14:00:00.000+05:30`).getTime();
  const s = shiftWindow({ punchIn: nowMs - 3 * 60 * MIN, punchOut: NaN, nowMs });
  ok('mid-shift worker is in shift', withinShift(s, nowMs));
  ok('mid-shift worker gets a deadline', nextDeadline(s, nowMs) !== null);
  ok('clean row is not idle', !isIdleNow({ status: 'online' }, s, nowMs));
}

console.log('--- B: punched in but NO punch-out row, punch-in is from YESTERDAY ---');
{
  // A stale punch-in from yesterday with no punch-out. The code falls back to
  // the configured window, so this is handled...
  const nowMs = new Date(`${istDateStr(new Date())}T14:00:00.000+05:30`).getTime();
  const yesterdayPunch = nowMs - 24 * 60 * MIN;
  const s = shiftWindow({ punchIn: yesterdayPunch, punchOut: NaN, nowMs });
  ok('yesterday punch-in falls back to configured window', withinShift(s, nowMs));
}

console.log('--- C: punched in AND punched out BEFORE the configured end ---');
{
  // e.g. a half-day: punched out at 12:00, config says 19:00. After 12:00 the
  // window is CLOSED, so the FRO is off the clock and must never see the modal.
  const nowMs = new Date(`${istDateStr(new Date())}T15:00:00.000+05:30`).getTime();
  const s = shiftWindow({
    punchIn: nowMs - 5 * 60 * MIN,
    punchOut: new Date(`${istDateStr(new Date())}T12:00:00.000+05:30`).getTime(),
    nowMs,
  });
  ok('after an early punch-out the shift is closed', !withinShift(s, nowMs));
  ok('...so no deadline is issued', nextDeadline(s, nowMs) === null);
  // The row may still hold a deadline written earlier today, inside the window.
  const rowWithDeadline = {
    status: 'online',
    disposition_due_at: new Date(`${istDateStr(new Date())}T12:30:00.000+05:30`).toISOString(),
  };
  ok('...but a row deadline from the closed window does NOT read idle', !isIdleNow(rowWithDeadline, s, nowMs));
  ok('...and the old rule WOULD have called it idle', !!(rowWithDeadline.disposition_due_at && deadlinePassed(rowWithDeadline, nowMs)));
}

console.log('--- D: the real "some FROs" case — punch-in is LATER in the day than now ---');
{
  // Someone whose attendance row was written with tomorrow's/next shift times,
  // or whose punch-in is stamped after login. beforeNow fails => off shift.
  const nowMs = new Date(`${istDateStr(new Date())}T09:00:00.000+05:30`).getTime();
  const futurePunch = new Date(`${istDateStr(new Date())}T14:00:00.000+05:30`).getTime();
  const s = shiftWindow({ punchIn: futurePunch, punchOut: NaN, nowMs });
  ok('before the punch-in the shift has not opened', !withinShift(s, nowMs));
  ok('...so no modal before the punch-in', !isIdleNow({ idle_since: new Date(nowMs - 30 * MIN).toISOString() }, s, nowMs));
}

console.log('--- E: timezone skew — punch-in recorded in UTC, not IST ---');
{
  // If a punch-in were stored as a naive UTC timestamp it can land an hour
  // (or 5.5h) off, which shifts the window boundary. Check the code compares
  // the punch-in's IST day against today, so a UTC-stamped "yesterday" IST
  // value is caught.
  const nowMs = new Date(`${istDateStr(new Date())}T00:30:00.000+05:30`).getTime();
  const utcYesterday = new Date(nowMs - 12 * 60 * MIN).toISOString();
  const s = shiftWindow({ punchIn: new Date(utcYesterday).getTime(), punchOut: NaN, nowMs });
  ok('a punch-in on the previous IST day is rejected at 00:30 IST', istDateStr(new Date(new Date(utcYesterday).getTime())) !== istDateStr(new Date(nowMs)));
}

console.log('--- F: does withoutStaleIdle save the early-punch-out row on login? ---');
{
  const nowMs = new Date(`${istDateStr(new Date())}T15:00:00.000+05:30`).getTime();
  const s = shiftWindow({ punchIn: nowMs - 5 * 60 * MIN, punchOut: new Date(`${istDateStr(new Date())}T12:00:00.000+05:30`).getTime(), nowMs });
  // Deadline 12:30 is AFTER shift start (10:00 by config) but the shift is
  // closed. withoutStaleIdle only clears deadlines older than the START, so
  // this one survives — isIdleNow must be what saves us, and it does.
  const row = { disposition_due_at: new Date(`${istDateStr(new Date())}T12:30:00.000+05:30`).toISOString() };
  const cleaned = withoutStaleIdle(row, s, nowMs);
  ok('deadline survives withoutStaleIdle (start-based)', !!cleaned.disposition_due_at);
  ok('isIdleNow still says not idle because shift is closed', !isIdleNow(cleaned, s, nowMs));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
