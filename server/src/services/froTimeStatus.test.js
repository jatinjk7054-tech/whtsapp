// Contract tests for the read model a refreshed client hydrates from.
//
// The refresh bug was that the client rebuilt its own timer on mount. The fix is
// that /status/me returns the authoritative state and the client adopts it. These
// tests pin the two pure pieces behind that payload: how a legacy live row maps
// to a time state when the ledger is empty, and how the state is projected into
// the fields every screen (new and legacy) reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TIME_STATES, sumIntervalsByState } from '../utils/froTimeState.js';
import { legacyStateOf, fallbackIntervals, toStatusPayload } from './froTimeStatus.js';

const DAY = '2026-01-15';
const IST = (hhmmss) => Date.parse(`${DAY}T${hhmmss}+05:30`);
const iso = (ms) => new Date(ms).toISOString();

const SHIFT = { startMs: IST('09:00:00'), endMs: IST('18:00:00') };
const NOW = IST('10:30:00');

// ---------------------------------------------------------------------------
// legacyStateOf — held states win, then off-shift, then idle, else working
// ---------------------------------------------------------------------------

test('a mid-window working row is WORKING (A)', () => {
  const row = { status: 'online', disposition_due_at: iso(IST('11:00:00')) };
  assert.equal(legacyStateOf(row, SHIFT, NOW), TIME_STATES.WORKING);
});

test('a lapsed deadline with no resume is IDLE (E)', () => {
  const row = { status: 'online', disposition_due_at: iso(IST('10:04:00')) };
  assert.equal(legacyStateOf(row, SHIFT, NOW), TIME_STATES.IDLE);
});

test('a meeting row is MEETING even with a lapsed deadline (C)', () => {
  const row = { status: 'meeting', disposition_due_at: iso(IST('10:04:00')) };
  assert.equal(legacyStateOf(row, SHIFT, NOW), TIME_STATES.MEETING);
});

test('an admin pause wins over a meeting row (D)', () => {
  const row = { status: 'meeting', is_paused: true, disposition_due_at: iso(IST('10:04:00')) };
  assert.equal(legacyStateOf(row, SHIFT, NOW), TIME_STATES.PAUSED);
});

test('outside the shift the row is OFF_SHIFT (F)', () => {
  const row = { status: 'online' };
  assert.equal(legacyStateOf(row, SHIFT, IST('20:00:00')), TIME_STATES.OFF_SHIFT);
});

// ---------------------------------------------------------------------------
// fallbackIntervals — used only while the ledger is empty for the day
// ---------------------------------------------------------------------------

test('a pre-ledger idle row reconstructs WORKING then an open IDLE at the deadline', () => {
  const row = { status: 'online', disposition_due_at: iso(IST('10:04:00')) };
  const intervals = fallbackIntervals(row, SHIFT, NOW);
  assert.equal(intervals.length, 2);
  assert.deepEqual(
    [intervals[0].state, intervals[0].started_at, intervals[0].ended_at],
    [TIME_STATES.WORKING, iso(SHIFT.startMs), iso(IST('10:04:00'))],
  );
  assert.equal(intervals[1].state, TIME_STATES.IDLE);
  assert.equal(intervals[1].started_at, iso(IST('10:04:00')));
  assert.equal(intervals[1].ended_at, null);
});

test('a pre-ledger working row is a single open interval from the shift start', () => {
  const row = { status: 'online', disposition_due_at: iso(IST('11:00:00')) };
  const intervals = fallbackIntervals(row, SHIFT, NOW);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].state, TIME_STATES.WORKING);
  assert.equal(intervals[0].started_at, iso(SHIFT.startMs));
});

// ---------------------------------------------------------------------------
// toStatusPayload — the wire shape a refresh consumes
// ---------------------------------------------------------------------------

const totalsOf = (intervals) => sumIntervalsByState(intervals, { shift: SHIFT, nowMs: NOW });

test('a WORKING payload is not idle and carries no idle_since (A)', () => {
  const payload = toStatusPayload({
    state: TIME_STATES.WORKING,
    totals: totalsOf([{ state: TIME_STATES.WORKING, started_at: iso(SHIFT.startMs), ended_at: null }]),
    legacyIdleSince: null,
    inShift: true,
  });
  assert.equal(payload.time_state, TIME_STATES.WORKING);
  assert.equal(payload.is_idle, false);
  assert.equal(payload.idle_since, null);
  assert.equal(payload.today_idle_seconds, 0);
});

test('an IDLE payload is idle and exposes the idle start (B)', () => {
  const intervals = [
    { state: TIME_STATES.WORKING, started_at: iso(SHIFT.startMs), ended_at: iso(IST('10:04:00')) },
    { state: TIME_STATES.IDLE, started_at: iso(IST('10:04:00')), ended_at: null },
  ];
  const payload = toStatusPayload({
    state: TIME_STATES.IDLE,
    totals: totalsOf(intervals),
    legacyIdleSince: iso(IST('10:04:00')),
    inShift: true,
  });
  assert.equal(payload.time_state, TIME_STATES.IDLE);
  assert.equal(payload.is_idle, true);
  assert.equal(payload.idle_since, iso(IST('10:04:00')));
  assert.equal(payload.idle_seconds_today, payload.today_idle_seconds);
  assert.equal(payload.idle_minutes, Math.floor(payload.today_idle_seconds / 60));
});

test('an INTERNET_PROBLEM payload is held, never idle (E)', () => {
  const intervals = [
    { state: TIME_STATES.WORKING, started_at: iso(SHIFT.startMs), ended_at: iso(IST('10:00:00')) },
    { state: TIME_STATES.INTERNET_PROBLEM, started_at: iso(IST('10:00:00')), ended_at: null },
  ];
  const payload = toStatusPayload({
    state: TIME_STATES.INTERNET_PROBLEM,
    totals: totalsOf(intervals),
    legacyIdleSince: null,
    inShift: true,
  });
  assert.equal(payload.time_state, TIME_STATES.INTERNET_PROBLEM);
  assert.equal(payload.is_idle, false);
  assert.ok(payload.internet_problem_seconds_today > 0);
  assert.ok(payload.worked_seconds_today >= payload.internet_problem_seconds_today);
});
