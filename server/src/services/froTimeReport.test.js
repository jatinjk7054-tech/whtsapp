// Contract tests for the historical idle reporting layer (froTimeReport).
//
// Reporting is where the WORKED / IDLE classification earns its keep: the same
// interval ledger that answers "where is this worker now" is re-read as history.
// The two rules that must never drift are (1) MEETING/PAUSE/INTERNET_PROBLEM are
// WORKED, not idle, and (2) an interval is split at IST midnight so it cannot be
// billed wholly to the day it started. These tests pin both, plus range/month
// enumeration and open-interval clipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  istMidnightMs,
  istDayRangeToMs,
  splitIntervalByIstDay,
  perDayStateTotals,
  enumerateIstDays,
  idleSessionsForDay,
} from './froTimeReport.js';

const DAY = '2026-01-15';
const IST = (hhmmss, day = DAY) => Date.parse(`${day}T${hhmmss}+05:30`);
const iso = (ms) => new Date(ms).toISOString();
const session = (state, startDay, start, endDay, end, extra = {}) => ({
  state,
  started_at: iso(IST(start, startDay)),
  ended_at: end == null ? null : iso(IST(end, endDay)),
  ...extra,
});

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

test('istMidnightMs resolves the IST (not UTC) midnight of a date', () => {
  assert.equal(istMidnightMs('2026-01-15'), Date.parse('2026-01-14T18:30:00.000Z'));
});

test('istDayRangeToMs is the half-open [midnight, next-midnight) window', () => {
  const { fromMs, toMs } = istDayRangeToMs('2026-01-15', '2026-01-15');
  assert.equal(toMs - fromMs, 24 * 60 * 60 * 1000);
  assert.equal(fromMs, istMidnightMs('2026-01-15'));
  assert.equal(toMs, istMidnightMs('2026-01-16'));
});

test('enumerateIstDays is inclusive across a month boundary', () => {
  assert.deepEqual(enumerateIstDays('2026-01-30', '2026-02-02'), [
    '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
  ]);
});

// ---------------------------------------------------------------------------
// splitIntervalByIstDay
// ---------------------------------------------------------------------------

test('an interval inside one IST day is a single segment', () => {
  const segs = splitIntervalByIstDay(session('IDLE', DAY, '10:00:00', DAY, '10:05:00'), {
    fromMs: istMidnightMs(DAY),
    toMs: istMidnightMs(DAY) + 86400000,
  });
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], {
    day: DAY, state: 'IDLE', startMs: IST('10:00:00'), endMs: IST('10:05:00'), seconds: 300,
  });
});

test('an interval crossing IST midnight is split 2m/12m, not billed to one day', () => {
  const segs = splitIntervalByIstDay(session('IDLE', DAY, '23:58:00', '2026-01-16', '00:12:00'), {
    fromMs: istMidnightMs('2026-01-15'),
    toMs: istMidnightMs('2026-01-17'),
  });
  assert.deepEqual(segs.map((s) => [s.day, s.seconds]), [['2026-01-15', 120], ['2026-01-16', 720]]);
});

test('an open interval is clipped at nowMs, never given a fabricated end', () => {
  const nowMs = IST('10:05:00');
  const segs = splitIntervalByIstDay(session('IDLE', DAY, '10:00:00', DAY, null), {
    fromMs: istMidnightMs(DAY),
    toMs: istMidnightMs(DAY) + 86400000,
    nowMs,
  });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].endMs, nowMs);
  assert.equal(segs[0].seconds, 300);
});

test('an interval that ended before the range starts is dropped', () => {
  const segs = splitIntervalByIstDay(session('IDLE', '2026-01-10', '10:00:00', '2026-01-10', '11:00:00'), {
    fromMs: istMidnightMs(DAY),
    toMs: istMidnightMs(DAY) + 86400000,
  });
  assert.deepEqual(segs, []);
});

test('sub-second fragments are dropped rather than rounded to a phantom second', () => {
  const segs = splitIntervalByIstDay({
    state: 'IDLE',
    started_at: iso(IST('10:00:00.000')),
    ended_at: iso(IST('10:00:00.400')),
  }, { fromMs: istMidnightMs(DAY), toMs: istMidnightMs(DAY) + 86400000 });
  assert.deepEqual(segs, []);
});

test('an unknown state is ignored (no attribution to a phantom bucket)', () => {
  const segs = splitIntervalByIstDay({
    state: 'NONSENSE',
    started_at: iso(IST('10:00:00')),
    ended_at: iso(IST('11:00:00')),
  }, { fromMs: istMidnightMs(DAY), toMs: istMidnightMs(DAY) + 86400000 });
  assert.deepEqual(segs, []);
});

// ---------------------------------------------------------------------------
// perDayStateTotals — the classification contract
// ---------------------------------------------------------------------------

// The locked regression: held states are WORKED, and WORKED + IDLE must equal the
// span with no double counting. 6h working +30m meeting +20m pause +10m internet
// problem +1h idle -> worked 7h, idle 1h (NOT 8h).
test('held states (meeting/pause/internet) count as WORKED, not IDLE', () => {
  const intervals = [
    session('WORKING', DAY, '09:00:00', DAY, '15:00:00'),
    session('MEETING', DAY, '15:00:00', DAY, '15:30:00'),
    session('PAUSED', DAY, '15:30:00', DAY, '15:50:00'),
    session('INTERNET_PROBLEM', DAY, '15:50:00', DAY, '16:00:00'),
    session('IDLE', DAY, '16:00:00', DAY, '17:00:00'),
  ];
  const { total } = perDayStateTotals(intervals, {
    fromMs: istMidnightMs(DAY),
    toMs: istMidnightMs(DAY) + 86400000,
  });
  assert.equal(total.worked_seconds, 7 * 3600);
  assert.equal(total.idle_seconds, 1 * 3600);
  assert.equal(total.meeting_seconds, 1800);
  assert.equal(total.pause_seconds, 1200);
  assert.equal(total.internet_problem_seconds, 600);
});

test('sleeping and hidden are idle; off-shift is neither worked nor idle', () => {
  const intervals = [
    session('SLEEPING', DAY, '09:00:00', DAY, '09:30:00'),
    session('HIDDEN', DAY, '09:30:00', DAY, '10:00:00'),
    session('OFF_SHIFT', DAY, '10:00:00', DAY, '11:00:00'),
  ];
  const { total } = perDayStateTotals(intervals, {
    fromMs: istMidnightMs(DAY),
    toMs: istMidnightMs(DAY) + 86400000,
  });
  assert.equal(total.idle_seconds, 3600);
  assert.equal(total.sleep_hidden_seconds, 3600);
  assert.equal(total.worked_seconds, 0);
  assert.equal(total.off_shift_seconds, 3600);
});

test('one interval spanning midnight lands in two day buckets', () => {
  const { dayMap } = perDayStateTotals(
    [session('WORKING', DAY, '23:00:00', '2026-01-16', '01:00:00')],
    { fromMs: istMidnightMs('2026-01-15'), toMs: istMidnightMs('2026-01-17') },
  );
  assert.equal(dayMap.get('2026-01-15').WORKING, 3600);
  assert.equal(dayMap.get('2026-01-16').WORKING, 3600);
});

// ---------------------------------------------------------------------------
// idleSessionsForDay
// ---------------------------------------------------------------------------

test('only idle-family sessions are listed, clipped and day-split', () => {
  const intervals = [
    session('WORKING', DAY, '09:00:00', DAY, '10:00:00'),
    session('IDLE', DAY, '23:58:00', '2026-01-16', '00:12:00', { reason: 'disposition_timeout' }),
  ];
  const forDay = idleSessionsForDay(intervals, DAY);
  assert.equal(forDay.length, 1);
  assert.equal(forDay[0].state, 'IDLE');
  assert.equal(forDay[0].duration_seconds, 120);
  assert.equal(forDay[0].reason, 'disposition_timeout');
  assert.equal(forDay[0].open, false);
});

test('an open idle session is flagged open and ended at the clip point', () => {
  const nowMs = IST('10:05:00');
  const [s] = idleSessionsForDay(
    [session('IDLE', DAY, '10:00:00', DAY, null)],
    DAY,
    { nowMs },
  );
  assert.equal(s.open, true);
  assert.equal(s.duration_seconds, 300);
  assert.equal(s.ended_at, iso(nowMs));
});
