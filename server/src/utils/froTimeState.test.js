// Contract tests for the server-authoritative FRO time state machine.
//
// This module is pure, so these tests stand in for the whole classification
// contract: every second of the shift is exactly one state, WORKED and IDLE are
// disjoint, and the disposition timer is governed only by shift + held state.
// If these pass, no reader can disagree about a worker's day.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIME_STATES,
  ALL_TIME_STATES,
  WORKED_STATES,
  IDLE_STATES,
  HELD_STATES,
  TIME_EVENTS,
  isWorkedState,
  isIdleState,
  isHeldState,
  isKnownState,
  istDateStr,
  istDayBoundsMs,
  overlapMs,
  countableSeconds,
  sumIntervalsByState,
  resolveEventState,
  dispositionTimerRunning,
  secondsLeftFromDue,
  DISPOSITION_WINDOW_SECONDS,
} from './froTimeState.js';

const IST = (day, hhmmss) => Date.parse(`${day}T${hhmmss}+05:30`);
const iso = (ms) => new Date(ms).toISOString();

const DAY = '2026-01-15';
const at = (hhmmss) => IST(DAY, hhmmss);

// ---------------------------------------------------------------------------
// State families
// ---------------------------------------------------------------------------

test('the state families partition the states exactly as the contract says', () => {
  assert.deepEqual([...WORKED_STATES].sort(), ['INTERNET_PROBLEM', 'MEETING', 'PAUSED', 'WORKING']);
  assert.deepEqual([...IDLE_STATES].sort(), ['HIDDEN', 'IDLE', 'SLEEPING']);
  assert.deepEqual([...HELD_STATES].sort(), ['INTERNET_PROBLEM', 'MEETING', 'PAUSED']);

  // No state can be both worked and idle.
  for (const s of ALL_TIME_STATES) {
    assert.equal(isWorkedState(s) && isIdleState(s), false, `${s} cannot be both worked and idle`);
  }
  // OFF_SHIFT is neither worked nor idle.
  assert.equal(isWorkedState(TIME_STATES.OFF_SHIFT), false);
  assert.equal(isIdleState(TIME_STATES.OFF_SHIFT), false);
  // held ⊆ worked.
  for (const s of HELD_STATES) assert.equal(isWorkedState(s), true, `${s} must be worked`);
  assert.equal(isKnownState('WORKING'), true);
  assert.equal(isKnownState('NAPPING'), false);
});

// ---------------------------------------------------------------------------
// THE regression that motivated the rebuild
// ---------------------------------------------------------------------------

test('1h idle + 7h of held/working time reports worked=7h and idle=1h (NOT 8h)', () => {
  const shift = { startMs: at('09:00:00'), endMs: at('18:00:00') };
  const nowMs = at('23:30:00');

  const intervals = [
    { state: TIME_STATES.WORKING, started_at: iso(at('09:00:00')), ended_at: iso(at('15:00:00')) }, // 6h
    { state: TIME_STATES.MEETING, started_at: iso(at('15:00:00')), ended_at: iso(at('15:30:00')) }, // 30m
    { state: TIME_STATES.PAUSED, started_at: iso(at('15:30:00')), ended_at: iso(at('15:50:00')) }, // 20m
    { state: TIME_STATES.INTERNET_PROBLEM, started_at: iso(at('15:50:00')), ended_at: iso(at('16:00:00')) }, // 10m
    { state: TIME_STATES.IDLE, started_at: iso(at('16:00:00')), ended_at: iso(at('17:00:00')) }, // 1h
  ];

  const totals = sumIntervalsByState(intervals, { shift, nowMs });

  assert.equal(totals.worked_seconds, 7 * 3600, 'worked must be WORKING+MEETING+PAUSED+INTERNET_PROBLEM');
  assert.equal(totals.idle_seconds, 1 * 3600, 'idle must be only IDLE');
  assert.equal(totals.worked_seconds + totals.idle_seconds, 8 * 3600);
  // The bug would have reported worked = 8h (idle counted as worked).
  assert.notEqual(totals.worked_seconds, 8 * 3600);
});

test('held states count as worked, never as idle', () => {
  const shift = { startMs: at('09:00:00'), endMs: at('18:00:00') };
  const nowMs = at('18:00:00');
  for (const held of HELD_STATES) {
    const totals = sumIntervalsByState(
      [{ state: held, started_at: iso(at('10:00:00')), ended_at: iso(at('11:00:00')) }],
      { shift, nowMs }
    );
    assert.equal(totals.worked_seconds, 3600, `${held} is worked`);
    assert.equal(totals.idle_seconds, 0, `${held} is not idle`);
  }
});

test('an open interval is clipped at now, not at the shift end', () => {
  const shift = { startMs: at('09:00:00'), endMs: at('18:00:00') };
  const nowMs = at('10:00:00');
  const totals = sumIntervalsByState(
    [{ state: TIME_STATES.WORKING, started_at: iso(at('09:00:00')), ended_at: null }],
    { shift, nowMs }
  );
  assert.equal(totals.worked_seconds, 3600);
});

// ---------------------------------------------------------------------------
// Day / shift clipping
// ---------------------------------------------------------------------------

test('istDayBoundsMs is a 24h IST window and istDateStr is the IST calendar day', () => {
  // 2026-01-15T22:00Z is already 2026-01-16 03:30 IST.
  const b = istDayBoundsMs(Date.parse('2026-01-15T22:00:00Z'));
  assert.equal(b.endMs - b.startMs, 24 * 3600 * 1000);
  assert.equal(b.day, '2026-01-16');
  assert.equal(istDateStr(new Date('2026-01-15T22:00:00Z')), '2026-01-16');
});

test('idle accrued after the shift is not counted inside the shift', () => {
  const shift = { startMs: at('09:00:00'), endMs: at('18:00:00') };
  const nowMs = at('20:00:00');
  const totals = sumIntervalsByState(
    [{ state: TIME_STATES.IDLE, started_at: iso(at('17:30:00')), ended_at: iso(at('19:30:00')) }],
    { shift, nowMs }
  );
  // Only 17:30→18:00 falls inside the shift.
  assert.equal(totals.idle_seconds, 1800);
});

test('overlapMs is 0 for a degenerate or disjoint pair', () => {
  assert.equal(overlapMs(0, 10, 5, 15), 5);
  assert.equal(overlapMs(0, 10, 10, 20), 0);
  assert.equal(overlapMs(0, 10, 20, 30), 0);
  assert.equal(overlapMs(10, 5, 0, 100), 0);
});

test('countableSeconds clips to shift and day and rounds to whole seconds', () => {
  const day = istDayBoundsMs(at('12:00:00'));
  const secs = countableSeconds({
    startMs: day.startMs - 3600 * 1000,
    endMs: day.startMs + 90000,
    shift: { startMs: day.startMs, endMs: day.endMs },
    nowMs: at('12:00:00'),
    dayBounds: day,
  });
  assert.equal(secs, 90);
});

// ---------------------------------------------------------------------------
// resolveEventState — held states win
// ---------------------------------------------------------------------------

test('held states are entered unconditionally, from any state', () => {
  for (const cur of ALL_TIME_STATES) {
    assert.equal(resolveEventState(cur, TIME_EVENTS.MEETING_START), TIME_STATES.MEETING);
    assert.equal(resolveEventState(cur, TIME_EVENTS.PAUSE_START), TIME_STATES.PAUSED);
    assert.equal(resolveEventState(cur, TIME_EVENTS.NETWORK_OFFLINE), TIME_STATES.INTERNET_PROBLEM);
    assert.equal(resolveEventState(cur, TIME_EVENTS.CONNECTIVITY_FAILURE), TIME_STATES.INTERNET_PROBLEM);
  }
});

test('page hidden/sleep never overrides an approved hold', () => {
  for (const held of HELD_STATES) {
    assert.equal(resolveEventState(held, TIME_EVENTS.PAGE_HIDDEN), null, `PAGE_HIDDEN during ${held}`);
    assert.equal(resolveEventState(held, TIME_EVENTS.SLEEP_START), null, `SLEEP_START during ${held}`);
  }
  assert.equal(resolveEventState(TIME_STATES.WORKING, TIME_EVENTS.PAGE_HIDDEN), TIME_STATES.HIDDEN);
  assert.equal(resolveEventState(TIME_STATES.IDLE, TIME_EVENTS.PAGE_HIDDEN), TIME_STATES.HIDDEN);
  assert.equal(resolveEventState(TIME_STATES.WORKING, TIME_EVENTS.SLEEP_START), TIME_STATES.SLEEPING);
});

test('a held state is only left by its own matching end event', () => {
  assert.equal(resolveEventState(TIME_STATES.MEETING, TIME_EVENTS.MEETING_END), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.MEETING, TIME_EVENTS.PAUSE_END), null);
  assert.equal(resolveEventState(TIME_STATES.PAUSED, TIME_EVENTS.PAUSE_END), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.PAUSED, TIME_EVENTS.MEETING_END), null);
  assert.equal(resolveEventState(TIME_STATES.INTERNET_PROBLEM, TIME_EVENTS.NETWORK_ONLINE), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.INTERNET_PROBLEM, TIME_EVENTS.CONNECTIVITY_RECOVERED), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.WORKING, TIME_EVENTS.NETWORK_ONLINE), null);
});

test('page visible / sleep end only clears a hidden or sleeping state', () => {
  assert.equal(resolveEventState(TIME_STATES.HIDDEN, TIME_EVENTS.PAGE_VISIBLE), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.SLEEPING, TIME_EVENTS.PAGE_VISIBLE), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.WORKING, TIME_EVENTS.PAGE_VISIBLE), null);
  assert.equal(resolveEventState(TIME_STATES.HIDDEN, TIME_EVENTS.SLEEP_END), TIME_STATES.WORKING);
});

test('a successful disposition clears idle but never punches through a hold', () => {
  assert.equal(resolveEventState(TIME_STATES.IDLE, TIME_EVENTS.DISPOSITION_SUCCESS), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.HIDDEN, TIME_EVENTS.DISPOSITION_SUCCESS), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.SLEEPING, TIME_EVENTS.DISPOSITION_SUCCESS), TIME_STATES.WORKING);
  for (const held of HELD_STATES) {
    assert.equal(resolveEventState(held, TIME_EVENTS.DISPOSITION_SUCCESS), null, `must not lift ${held}`);
  }
});

test('shift end always wins; shift start only leaves OFF_SHIFT', () => {
  for (const cur of ALL_TIME_STATES) {
    assert.equal(resolveEventState(cur, TIME_EVENTS.SHIFT_END), TIME_STATES.OFF_SHIFT);
  }
  assert.equal(resolveEventState(TIME_STATES.OFF_SHIFT, TIME_EVENTS.SHIFT_START), TIME_STATES.WORKING);
  assert.equal(resolveEventState(TIME_STATES.WORKING, TIME_EVENTS.SHIFT_START), null);
});

test('an unknown event or unknown current state is never actionable', () => {
  assert.equal(resolveEventState(TIME_STATES.WORKING, 'TELEPORT'), null);
  assert.equal(resolveEventState('BOGUS', TIME_EVENTS.MEETING_END), null);
});

// ---------------------------------------------------------------------------
// Disposition timer
// ---------------------------------------------------------------------------

test('the disposition countdown runs only in-shift and outside a held state', () => {
  assert.equal(dispositionTimerRunning(TIME_STATES.WORKING, { inShift: true }), true);
  assert.equal(dispositionTimerRunning(TIME_STATES.IDLE, { inShift: true }), true);
  assert.equal(dispositionTimerRunning(TIME_STATES.HIDDEN, { inShift: true }), true);
  assert.equal(dispositionTimerRunning(TIME_STATES.SLEEPING, { inShift: true }), true);
  for (const held of HELD_STATES) {
    assert.equal(dispositionTimerRunning(held, { inShift: true }), false, `${held} pauses the timer`);
  }
  assert.equal(dispositionTimerRunning(TIME_STATES.WORKING, { inShift: false }), false);
  assert.equal(dispositionTimerRunning(TIME_STATES.OFF_SHIFT, { inShift: true }), false);
});

test('secondsLeftFromDue clamps at zero and tolerates junk', () => {
  const now = at('12:00:00');
  assert.equal(secondsLeftFromDue(iso(now + DISPOSITION_WINDOW_SECONDS * 1000), now), DISPOSITION_WINDOW_SECONDS);
  assert.equal(secondsLeftFromDue(iso(now - 60000), now), 0);
  assert.equal(secondsLeftFromDue(null, now), null);
  assert.equal(secondsLeftFromDue('not-a-date', now), null);
});
