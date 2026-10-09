// The re-arm rule for the FRO's 4-minute disposition window, under the
// server-authoritative time machine.
//
// A successful, backend-confirmed disposition re-arms the deadline and clears
// idle_since. It does NOT accumulate idle: the authoritative idle total is the
// sum of the intervals in fro_time_sessions, and the legacy today_idle_seconds
// column is derived from that ledger on read. buildLiveWindow() is the pure rule;
// resetLiveWindow() is the thin write path around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveWindow, resetLiveWindow } from './froLiveWindow.js';

// Fixed clock: 2026-09-29T12:00:00Z = 17:30 IST, mid-afternoon inside any shift.
const NOW = Date.parse('2026-09-29T12:00:00Z');
const SHIFT = { startMs: NOW - 8 * 3600 * 1000, endMs: NOW + 4 * 3600 * 1000 };
const ago = (ms) => new Date(NOW - ms).toISOString();
const DUE = new Date(NOW + 240 * 1000).toISOString();

test('a disposition re-arms the window, clears idle_since, and punches an idle row online', () => {
  const liveRow = {
    worker_id: 'f1',
    status: 'idle',
    today_idle_seconds: 120, // stale legacy column — must not be written or carried
    idle_since: ago(5 * 60 * 1000),
    disposition_due_at: null,
  };
  const { patch, timer } = buildLiveWindow({ workerId: 'f1', liveRow, shift: SHIFT, nowMs: NOW });

  assert.equal(patch.disposition_due_at, DUE);
  assert.equal(patch.idle_since, null);
  assert.equal(patch.status, 'online');
  assert.equal(patch.current_donor_id, null);
  assert.equal(patch.call_started_at, null);
  // The ledger owns today_idle_seconds; this path never writes it.
  assert.equal('today_idle_seconds' in patch, false);
  assert.equal(timer.seconds_left, 240);
  assert.equal(timer.is_idle, false);
  assert.equal('today_idle_seconds' in timer, false);
});

test('a frozen row re-arms but never punches back to online', () => {
  for (const frozen of [
    { status: 'idle', is_paused: true },
    { status: 'meeting', is_paused: false },
  ]) {
    const liveRow = {
      worker_id: 'f1',
      ...frozen,
      today_idle_seconds: 0,
      idle_since: ago(5 * 60 * 1000),
      disposition_due_at: null,
    };
    const { patch } = buildLiveWindow({ workerId: 'f1', liveRow, shift: SHIFT, nowMs: NOW });

    assert.equal(patch.disposition_due_at, DUE);
    assert.equal(patch.idle_since, null);
    assert.equal('status' in patch, false, `frozen row must not flip status (${frozen.status})`);
  }
});

test('a missing live row still builds the patch and timer without a status flip', () => {
  const { patch, timer } = buildLiveWindow({ workerId: 'f1', liveRow: null, shift: SHIFT, nowMs: NOW });

  assert.equal(patch.worker_id, 'f1');
  assert.equal(patch.disposition_due_at, DUE);
  assert.equal('status' in patch, false);
  assert.equal('today_idle_seconds' in patch, false);
  assert.equal(timer.seconds_left, 240);
  assert.equal(timer.is_idle, false);
});

test('outside the shift the window is not re-armed', () => {
  const liveRow = { worker_id: 'f1', status: 'idle', today_idle_seconds: 0 };
  const offShift = { startMs: NOW - 2 * 3600 * 1000, endMs: NOW - 3600 * 1000 };
  const { patch, timer } = buildLiveWindow({ workerId: 'f1', liveRow, shift: offShift, nowMs: NOW });

  assert.equal(patch.disposition_due_at, null);
  assert.equal(timer.seconds_left, null);
  assert.equal(timer.is_idle, false);
});

test('resetLiveWindow reads and upserts the given worker row and returns the timer', async () => {
  const seen = { upserts: [] };
  const liveRow = { worker_id: 'f1', status: 'idle', today_idle_seconds: 0 };
  const fakeDb = {
    seen,
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: table === 'fro_live_status' ? liveRow : null }),
          }),
        }),
        upsert: async (patch, opts) => {
          seen.upserts.push({ table, patch, opts });
          return { error: null };
        },
      };
    },
  };

  const timer = await resetLiveWindow('f1', {
    nowMs: NOW,
    dbClient: fakeDb,
    getShift: async () => SHIFT,
  });

  assert.equal(seen.upserts.length, 1);
  assert.equal(seen.upserts[0].table, 'fro_live_status');
  assert.equal(seen.upserts[0].opts.onConflict, 'worker_id');
  assert.equal(seen.upserts[0].patch.worker_id, 'f1');
  assert.equal(seen.upserts[0].patch.status, 'online');
  assert.equal('today_idle_seconds' in seen.upserts[0].patch, false);
  assert.equal(timer.seconds_left, 240);
  assert.equal(timer.is_idle, false);
});

// A row whose stats_date is still yesterday. Nobody stamped this FRO, no heartbeat
// landed, the machine was off overnight.
function staleRow(dayStr) {
  return {
    worker_id: 'f1',
    status: 'idle',
    stats_date: dayStr,
    updated_at: `${dayStr}T20:00:00.000Z`,
    // Deliberately absurd-looking: the point is that these must not survive into
    // today, where they would only ever be able to rise.
    today_idle_seconds: 8 * 3600,
    today_talk_seconds: 4 * 3600,
    today_calls: 37,
    idle_since: null,
    disposition_due_at: null,
  };
}

function capturingDb(liveRow) {
  const seen = { upserts: [] };
  return {
    seen,
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: table === 'fro_live_status' ? liveRow : null }),
          }),
        }),
        upsert: async (patch, opts) => {
          seen.upserts.push({ table, patch, opts });
          return { error: null };
        },
      };
    },
  };
}

test('a stale row is rolled to zero before stats_date is restamped as today', async () => {
  // NOW is 2026-09-29 in IST (17:30 IST on the 29th), so the stale day below is
  // the 28th.
  const fakeDb = capturingDb(staleRow('2026-09-28'));

  await resetLiveWindow('f1', { nowMs: NOW, dbClient: fakeDb, getShift: async () => SHIFT });

  assert.equal(fakeDb.seen.upserts.length, 1);
  const { patch } = fakeDb.seen.upserts[0];

  assert.equal(patch.stats_date, '2026-09-29', 'restamped to today');
  // Every retained counter named explicitly. The upsert is partial, so a column
  // left out keeps its stored value - which is how yesterday's total used to
  // survive under a fresh date.
  assert.equal(patch.today_talk_seconds, 0);
  assert.equal(patch.today_calls, 0);
  assert.equal(patch.today_break_seconds, 0);
  assert.equal(patch.today_skipped, 0);
  // today_idle_seconds is no longer a live counter; the ledger owns idle now.
  assert.equal('today_idle_seconds' in patch, false);
  assert.equal(patch.idle_since, null);
  assert.equal(patch.status, 'online', 'still punched back online by the window');
});

test('a row already dated today is not rolled', async () => {
  const fakeDb = capturingDb(staleRow('2026-09-29'));

  await resetLiveWindow('f1', { nowMs: NOW, dbClient: fakeDb, getShift: async () => SHIFT });

  const { patch } = fakeDb.seen.upserts[0];
  assert.equal(patch.stats_date, '2026-09-29');
  // No counter is named at all. The row's committed total already belongs to
  // today, so there is nothing to zero - and zeroing it would wipe a real day's
  // work.
  assert.equal('today_idle_seconds' in patch, false);
  assert.equal('today_talk_seconds' in patch, false);
  assert.equal('today_calls' in patch, false);
});

test('a stale row reports a fresh 4-minute timer and no idle counter', async () => {
  const fakeDb = capturingDb(staleRow('2026-09-28'));

  const timer = await resetLiveWindow('f1', { nowMs: NOW, dbClient: fakeDb, getShift: async () => SHIFT });

  assert.equal('today_idle_seconds' in timer, false);
  assert.equal(timer.seconds_left, 240);
});
