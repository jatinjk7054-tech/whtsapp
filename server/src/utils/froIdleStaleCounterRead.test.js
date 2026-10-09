// A live-status row whose "today" counters still belong to yesterday.
//
// The rollover that clears those counters lives on the WRITE paths, so a worker
// who has not written to their row since yesterday evening still carries
// yesterday's numbers on it. Every read path then has to decide for itself
// whether those numbers belong to today — and the admin boards did not, so the
// first thing the office saw in the morning was yesterday's banked idle
// (6h53m at 10:26am, with a "0%" productivity next to it) sitting on rows that
// had not been touched since the night before.
//
// The test that failed before the fix: liveIdleSeconds() returned the stale
// committed total whenever no idle period was open, because that early return
// skipped the day check the line below it performed. The day check it performed
// was itself inert — idlePeriodStartMs() only ever returns a start on today's
// IST day — so the row's own stats_date is the only thing that can answer the
// question, and nothing asked it.
//
// Fixed clock, no wall-clock dependency. 2026-09-29T05:00:00Z is 10:30 IST, half
// an hour into the working day — the moment this was reported.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  counterDayOf,
  isCounterDayStale,
  liveIdleSeconds,
  openIdleSeconds,
} from './froIdle.js';

const NOW = Date.parse('2026-09-29T05:00:00Z');
const TODAY = '2026-09-29';
const YESTERDAY = '2026-09-28';
// 7:30:20pm the night before — the last thing that wrote these rows.
const LAST_SEEN = '2026-09-28T14:00:20Z';

const SHIFT = { startMs: Date.parse('2026-09-29T04:30:00Z'), endMs: Date.parse('2026-09-29T13:30:00Z') };

// What the night-before commit left behind: a large banked total, no open
// period, and a deadline from yesterday that is long since lapsed.
const staleRow = (over = {}) => ({
  worker_id: 'w1',
  status: 'online',
  stats_date: YESTERDAY,
  today_idle_seconds: 6 * 3600 + 53 * 60 + 50,   // 6:53:50
  today_calls: 0,
  today_talk_seconds: 0,
  idle_since: null,
  disposition_due_at: null,
  is_paused: false,
  updated_at: LAST_SEEN,
  ...over,
});

test('counterDayOf reads the explicit stamp, Date-typed or string', () => {
  assert.equal(counterDayOf({ stats_date: YESTERDAY }), YESTERDAY);
  assert.equal(counterDayOf({ stats_date: new Date(`${TODAY}T00:00:00Z`) }), TODAY);
});

test('counterDayOf falls back to updated_at, then gives up rather than guess', () => {
  assert.equal(counterDayOf({ updated_at: LAST_SEEN }), YESTERDAY);
  assert.equal(counterDayOf({}), null);
  assert.equal(counterDayOf(null), null);
});

test('a row whose counters belong to yesterday is stale', () => {
  assert.equal(isCounterDayStale(staleRow(), NOW), true);
  assert.equal(isCounterDayStale(staleRow({ stats_date: TODAY }), NOW), false);
  // No evidence of any day: cannot be claimed to belong to a past day.
  assert.equal(isCounterDayStale({}, NOW), false);
  assert.equal(isCounterDayStale(null, NOW), false);
});

test("yesterday's banked idle is not reported as today's", () => {
  // THE regression. No open period, so this returns on the committed-only path,
  // which is the path that used to skip the day check entirely.
  assert.equal(liveIdleSeconds(staleRow(), SHIFT, NOW), 0);
});

test('yesterday\'s banked idle is not reported on a row still mid-period either', () => {
  // A row can carry a lapsed deadline from yesterday AND a stale committed
  // total. idlePeriodStartMs rejects the yesterday deadline, so the committed
  // path is taken again — the stale total must not ride along with it.
  const row = staleRow({ disposition_due_at: '2026-09-28T14:00:00Z' });
  assert.equal(liveIdleSeconds(row, SHIFT, NOW), 0);
});

test('a stale row banks nothing even when the frozen cutoff would let time run', () => {
  // The covered-away cap must not become a way to smuggle yesterday's total
  // back in as "idle before they left".
  assert.equal(liveIdleSeconds(staleRow(), SHIFT, NOW, NOW), 0);
});

test("today's own committed idle still counts", () => {
  const row = staleRow({ stats_date: TODAY, today_idle_seconds: 600, updated_at: new Date(NOW - 60_000).toISOString() });
  assert.equal(liveIdleSeconds(row, SHIFT, NOW), 600);
});

test('a row with no day evidence at all is trusted rather than zeroed', () => {
  // Pre-migration rows carry no stats_date. Zeroing those would wipe real idle
  // for every existing worker, which is worse than briefly trusting one.
  const row = { today_idle_seconds: 900, idle_since: null, disposition_due_at: null };
  assert.equal(liveIdleSeconds(row, SHIFT, NOW), 900);
});

test('an open period on a stale row counts only the open part', () => {
  // The committed half belongs to yesterday; the open stretch began today, so
  // that much is genuinely today's and is what the board should show.
  const openStart = NOW - 15 * 60 * 1000;
  const row = staleRow({ idle_since: new Date(openStart).toISOString() });
  assert.equal(liveIdleSeconds(row, SHIFT, NOW), 15 * 60);
  assert.equal(openIdleSeconds(row, SHIFT, NOW), 15 * 60);
});

test('the open-streak figure is already 0 for a stale row', () => {
  // openIdleSeconds had no gap here — pinning it so a future change cannot
  // reintroduce one.
  assert.equal(openIdleSeconds(staleRow(), SHIFT, NOW), 0);
});
