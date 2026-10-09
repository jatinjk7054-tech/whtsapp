// Read-surface contract under the server-authoritative time machine.
//
// The old idle strip folded an open stretch into today_idle_seconds on every
// disposition. That accumulation is gone: the authoritative idle total is the
// running/closed intervals in fro_time_sessions, and the legacy column is derived
// from that ledger on read (froTimeStatus.js). These tests pin the two rules the
// read surfaces still depend on:
//
//   1. buildLiveWindow() re-arms and clears idle_since but never banks idle.
//   2. The shared live-row column list still carries the columns that change the
//      freeze/held-state answer, and no longer carries the removed accumulators.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveWindow } from './froLiveWindow.js';
import { FRO_IDLE_LIVE_COLS } from '../utils/froIdleCols.js';

// Fixed clock: 2026-09-29T12:00:00Z = 17:30 IST, inside any ordinary shift.
const NOW = Date.parse('2026-09-29T12:00:00Z');
const SHIFT = { startMs: NOW - 8 * 3600 * 1000, endMs: NOW + 4 * 3600 * 1000 };

test('a disposition re-arms and closes the running stretch without banking it', () => {
  const lapsed = {
    worker_id: 'f1',
    status: 'idle',
    stats_date: '2026-09-29',
    today_idle_seconds: 0,
    idle_since: new Date(NOW - 2 * 60 * 1000).toISOString(),
    disposition_due_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
  };

  const { patch } = buildLiveWindow({ workerId: 'f1', liveRow: lapsed, shift: SHIFT, nowMs: NOW });

  assert.equal('today_idle_seconds' in patch, false, 'the ledger owns idle; this path must not write it');
  assert.equal(patch.idle_since, null, 'the running stretch is closed');
  assert.equal(patch.disposition_due_at, new Date(NOW + 240 * 1000).toISOString(), 'window re-armed to 4 minutes');
});

test('a frozen row is re-armed but its status is left alone', () => {
  const frozen = {
    worker_id: 'f1', status: 'meeting', stats_date: '2026-09-29',
    is_paused: false, today_idle_seconds: 0,
    idle_since: new Date(NOW - 2 * 60 * 1000).toISOString(),
    disposition_due_at: null,
  };
  const { patch } = buildLiveWindow({ workerId: 'f1', liveRow: frozen, shift: SHIFT, nowMs: NOW });

  assert.equal(patch.disposition_due_at, new Date(NOW + 240 * 1000).toISOString());
  assert.equal('status' in patch, false, 'a held state must never be punched back online');
});

test('the shared live-row column list carries what the freeze reads and no removed accumulators', () => {
  const cols = FRO_IDLE_LIVE_COLS.split(',').map((c) => c.trim());
  for (const required of ['stats_date', 'frozen_at', 'disposition_due_at', 'updated_at', 'is_paused', 'status']) {
    assert.ok(cols.includes(required), `FRO_IDLE_LIVE_COLS must include ${required}`);
  }
  // today_idle_seconds and idle_since are no longer authoritative; they are
  // derived from the ledger on read and must not be hand-written into the list.
  assert.equal(cols.includes('today_idle_seconds'), false, 'today_idle_seconds is ledger-derived now');
  assert.equal(cols.includes('idle_since'), false, 'idle_since is not an authoritative column');
  assert.equal(new Set(cols).size, cols.length, 'no duplicated columns');
});
