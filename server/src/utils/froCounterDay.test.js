/**
 * Tests for the day-rollover of the live-status counters, and the 24h cap.
 *
 * The bug being locked down
 * ------------------------
 * fro_live_status is one row per worker holding "today" counters, written
 * monotonically. The old rollover cleared them only when the worker happened to be
 * in an OPEN idle period at the boundary, so finishing a day with idle_since = NULL
 * left yesterday's total in place. Today's idle was added on top and the daily
 * snapshot recorded the running total as one day — which is how 52h19m of idle
 * ended up in a single fro_daily_stats row. These tests pin the unconditional
 * rollover and the cap that makes such a figure unrepresentable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  counterDayOf, isCounterDayStale, capIdleSeconds, rollCountersForNewDay,
  MAX_IDLE_SECONDS_PER_DAY,
} from '../services/froCounterDay.js';
import { istDateStr, liveIdleSeconds } from '../utils/froIdle.js';

const NOW = Date.parse('2026-09-15T14:00:00Z');
const today = istDateStr(new Date(NOW));
// 00:00 IST on the day before, which is 18:30Z the previous evening.
const yesterday = istDateStr(new Date(NOW - 24 * 60 * 60 * 1000));

// ── counterDayOf: which day do these counters belong to? ──────────────────────

test('counterDayOf prefers the explicit stamp over updated_at', () => {
  const row = { stats_date: '2026-09-15', updated_at: '2026-09-10T04:00:00Z' };
  assert.equal(counterDayOf(row), '2026-09-15');
});

test('counterDayOf reads a Date-typed stats_date (pg returns DATE as a Date)', () => {
  const row = { stats_date: new Date('2026-09-15T00:00:00Z') };
  assert.equal(counterDayOf(row), '2026-09-15');
});

test('counterDayOf falls back to updated_at when the row predates the stamp', () => {
  // A row written at 06:00Z on the 15th is 11:30 IST on the 15th, so the 15th.
  const row = { updated_at: '2026-09-15T06:00:00Z' };
  assert.equal(counterDayOf(row), '2026-09-15');
});

test('counterDayOf returns null when there is no evidence of any day', () => {
  // Crucially NOT "a day in the past": claiming a past day for a row we know
  // nothing about would make the first write bank the counters against a date
  // chosen out of thin air.
  assert.equal(counterDayOf({}), null);
  assert.equal(counterDayOf(null), null);
});

// ── isCounterDayStale: the condition the old reset was missing ────────────────

test('a row stamped with an earlier day is stale, idle_since or not', () => {
  // The regression case. idle_since: null is precisely the state that made the old
  // `cleaned.idle_since === null && row.idle_since` guard skip the reset.
  const row = { stats_date: yesterday, idle_since: null, today_idle_seconds: 180000 };
  assert.equal(isCounterDayStale(row, NOW), true);
});

test('a row stamped today is not stale', () => {
  const row = { stats_date: today, idle_since: null, today_idle_seconds: 180000 };
  assert.equal(isCounterDayStale(row, NOW), false);
});

test('an unstampable row is not treated as stale', () => {
  // Nothing to roll, and nothing to bank either.
  assert.equal(isCounterDayStale({}, NOW), false);
  assert.equal(isCounterDayStale(null, NOW), false);
});

// ── capIdleSeconds: a day cannot hold more idle than it has hours ─────────────

test('a day is capped at 24h no matter what the accumulator produced', () => {
  // The two real figures: 52h19m52s and 45h14m24s.
  assert.equal(capIdleSeconds(52 * 3600 + 19 * 60 + 52), MAX_IDLE_SECONDS_PER_DAY);
  assert.equal(capIdleSeconds(45 * 3600 + 14 * 60 + 24), MAX_IDLE_SECONDS_PER_DAY);
  assert.equal(capIdleSeconds(99 * 3600), MAX_IDLE_SECONDS_PER_DAY);
});

test('a caller-supplied shift cap is tighter than 24h and wins', () => {
  // A 10h shift: idle outside the window is not idle at all.
  const shiftMs = 10 * 3600 * 1000;
  assert.equal(capIdleSeconds(20 * 3600, shiftMs), 10 * 3600);
  assert.equal(capIdleSeconds(11 * 3600, shiftMs), 10 * 3600);
});

test('a longer caller cap cannot loosen the 24h ceiling', () => {
  // An over-long resolved shift (say a config typo) must not re-admit >24h.
  assert.equal(capIdleSeconds(30 * 3600, 48 * 3600 * 1000), MAX_IDLE_SECONDS_PER_DAY);
});

test('the cap never invents idle and never returns a negative', () => {
  assert.equal(capIdleSeconds(0), 0);
  assert.equal(capIdleSeconds(-500), 0);
  assert.equal(capIdleSeconds(null), 0);
  assert.equal(capIdleSeconds(undefined), 0);
  assert.equal(capIdleSeconds(1800), 1800);
});

test('a non-finite caller cap is ignored rather than poisoning the result', () => {
  // getShiftWindowMs returns NaN when attendance and settings are both unreadable.
  // The 24h ceiling must still hold, and must not be replaced by 0 or NaN.
  assert.equal(capIdleSeconds(30 * 3600, NaN), MAX_IDLE_SECONDS_PER_DAY);
  assert.equal(capIdleSeconds(30 * 3600, Infinity), MAX_IDLE_SECONDS_PER_DAY);
});

// ── rollCountersForNewDay: the rollover itself ─────────────────────────────────

// The service reaches for the db pool to bank the prior day, which is not available
// in a unit test. Stub it so the pure decision logic can be exercised.
//
// The stub is installed at module scope and deliberately NOT undone at the end of
// this file: node:test runs the async test callbacks after the module body has
// finished, so a restore statement here would uninstall the stub before the first
// assertion and every write would go to the real pool.
const banked = [];
const dbModule = await import('../config/db.js');
dbModule.default._pool.query = async (sql, params) => {
  // Only the daily-snapshot writes are of interest; the ledger read that now
  // feeds idle must not be mistaken for one of them.
  if (String(sql).trim().toUpperCase().startsWith('INSERT')) banked.push({ sql, params });
  return { rows: [] };
};

test('a stale row rolls: counters go to zero and stats_date moves to today', async () => {
  banked.length = 0;
  const row = { stats_date: yesterday, idle_since: null, today_idle_seconds: 180000, today_calls: 12 };
  const res = await rollCountersForNewDay('w1', row, NOW);
  assert.equal(res.rolled, true);
  assert.equal(res.priorDay, yesterday);
  assert.equal(res.statsDate, today);
  // today_idle_seconds is no longer a live-row counter: the authoritative idle
  // total comes from fro_time_sessions and is derived on read.
  assert.equal('today_idle_seconds' in res.counters, false);
  assert.equal(res.counters.today_calls, 0);
});

test('the previous day is banked against the PREVIOUS date, not today', async () => {
  banked.length = 0;
  // A plausible sub-24h total, so this test is purely about WHICH DATE the
  // previous day's numbers are booked against. The cap on an inflated value is
  // covered by the next test.
  const row = { stats_date: yesterday, idle_since: null, today_idle_seconds: 6 * 3600, today_calls: 12, today_talk_seconds: 3600 };
  await rollCountersForNewDay('w1', row, NOW);
  assert.equal(banked.length, 1);
  // params: [worker_id, date, talk, calls, idle]
  assert.equal(banked[0].params[0], 'w1');
  assert.equal(banked[0].params[1], yesterday, "the old day keeps its own total");
  assert.notEqual(banked[0].params[1], today);
  assert.equal(banked[0].params[2], 3600, 'talk books to the old day too');
  assert.equal(banked[0].params[3], 12, 'calls book to the old day too');
  // The live row no longer carries idle counters; fro_time_sessions is the
  // authoritative idle source, so nothing is banked from the stale column here.
  assert.equal(banked[0].params[4], 0);
});

test("a stale live row's inflated idle is not banked at all, so the cap is never reached", async () => {
  // The live row used to hold an ever-rising idle accumulator. It no longer
  // does: idle is summed from fro_time_sessions (already day-bounded), so the
  // rollover books zero for the column regardless of what the legacy cell says.
  banked.length = 0;
  const row = { stats_date: yesterday, idle_since: null, today_idle_seconds: 52 * 3600 + 20 * 60 };
  await rollCountersForNewDay('w1', row, NOW);
  assert.equal(banked[0].params[4], 0);
});

test('a current row does not roll and keeps its counters', async () => {
  banked.length = 0;
  const row = { stats_date: today, idle_since: null, today_idle_seconds: 1800, today_calls: 4 };
  const res = await rollCountersForNewDay('w1', row, NOW);
  assert.equal(res.rolled, false);
  assert.equal('today_idle_seconds' in res.counters, false, 'idle is not a live-row counter any more');
  assert.equal(res.counters.today_calls, 4);
  assert.equal(banked.length, 0, 'nothing is re-banked for the current day');
});

// ── The end-to-end shape that produced 52h in one day ─────────────────────────

test('a stale counter plus a fresh period no longer reaches the cap at all', () => {
  // What the exit path used to compute: yesterday's committed 50h still in the
  // row, plus a 2h open period, written to today's ledger row.
  const stale = {
    stats_date: yesterday,
    today_idle_seconds: 50 * 3600,
    idle_since: new Date(NOW - 2 * 3600 * 1000).toISOString(),
  };
  const shift = { startMs: NOW - 8 * 3600 * 1000, endMs: NOW + 4 * 3600 * 1000 };
  const afterRoll = { ...stale, today_idle_seconds: 0 };

  // The cap used to be what stopped 52h becoming a day: 50h + 2h came out of
  // liveIdleSeconds as 52h and only capIdleSeconds held it at 24h. The day check
  // now drops the stale half before it is ever added, so the figure is right
  // before any cap sees it. That assertion used to expect MAX_IDLE_SECONDS_PER_DAY.
  assert.equal(liveIdleSeconds(stale, shift, NOW), 2 * 3600, "yesterday's 50h is dropped, not capped");
  assert.equal(liveIdleSeconds(afterRoll, shift, NOW), 2 * 3600, 'after the rollover the day holds only the open period');

  // The cap is still the backstop for an over-count that is wrong WITHIN today,
  // which no day check can see.
  const sameDay = {
    stats_date: today,
    today_idle_seconds: 50 * 3600,
    idle_since: new Date(NOW - 2 * 3600 * 1000).toISOString(),
  };
  assert.equal(capIdleSeconds(liveIdleSeconds(sameDay, shift, NOW)), MAX_IDLE_SECONDS_PER_DAY);
});
