// Contract tests for the server-authoritative WORKING -> IDLE reconciliation.
//
// The deadline transition is the piece that replaces the idle heartbeat: when
// the 4-minute disposition window lapses with no disposition, a worker still in
// WORKING must become IDLE, and the IDLE interval must start at the DEADLINE,
// not at the moment the next request happened to arrive. These tests pin both.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TIME_STATES } from '../utils/froTimeState.js';
import { transition } from './froTimeSessions.js';
import { dispositionIdlePlan, reconcileDispositionIdle } from './froTimeReconcile.js';

const DAY = '2026-01-15';
const IST = (hhmmss) => Date.parse(`${DAY}T${hhmmss}+05:30`);
const iso = (ms) => new Date(ms).toISOString();

const SHIFT = { startMs: IST('09:00:00'), endMs: IST('18:00:00') };
const START = IST('10:00:00');
const DUE = IST('10:04:00');
const NOW = IST('10:30:00');

const liveRow = (over = {}) => ({ disposition_due_at: iso(DUE), ...over });

// ---------------------------------------------------------------------------
// dispositionIdlePlan — the pure decision
// ---------------------------------------------------------------------------

test('a WORKING worker past the deadline and in shift becomes idle AT the deadline', () => {
  const plan = dispositionIdlePlan({
    currentState: TIME_STATES.WORKING,
    liveRow: liveRow(),
    shift: SHIFT,
    nowMs: NOW,
    openStartedAtMs: START,
  });
  assert.deepEqual(plan, { atMs: DUE });
});

test('the idle start is never earlier than the open WORKING interval', () => {
  // A deadline that predates the WORKING interval it is leaving (skew) clamps up.
  const plan = dispositionIdlePlan({
    currentState: TIME_STATES.WORKING,
    liveRow: liveRow(),
    shift: SHIFT,
    nowMs: NOW,
    openStartedAtMs: DUE + 60000,
  });
  assert.equal(plan.atMs, DUE + 60000);
});

test('no plan when the deadline has not passed yet', () => {
  assert.equal(
    dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: liveRow(), shift: SHIFT, nowMs: DUE - 1000 }),
    null
  );
});

test('no plan without a usable deadline', () => {
  assert.equal(dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: {}, shift: SHIFT, nowMs: NOW }), null);
  assert.equal(
    dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: { disposition_due_at: 'nope' }, shift: SHIFT, nowMs: NOW }),
    null
  );
});

test('only WORKING is reconciled; every other state is left alone', () => {
  for (const state of Object.values(TIME_STATES)) {
    if (state === TIME_STATES.WORKING) continue;
    assert.equal(
      dispositionIdlePlan({ currentState: state, liveRow: liveRow(), shift: SHIFT, nowMs: NOW }),
      null,
      `${state} must not be reconciled to IDLE`
    );
  }
});

test('an approved hold overrides the lapsed deadline', () => {
  assert.equal(
    dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: liveRow({ is_paused: true }), shift: SHIFT, nowMs: NOW }),
    null
  );
  assert.equal(
    dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: liveRow({ status: 'meeting' }), shift: SHIFT, nowMs: NOW }),
    null
  );
});

test('off-shift is never billed as idle', () => {
  assert.equal(
    dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: liveRow(), shift: SHIFT, nowMs: IST('20:00:00') }),
    null
  );
  assert.equal(
    dispositionIdlePlan({ currentState: TIME_STATES.WORKING, liveRow: liveRow(), shift: null, nowMs: NOW }),
    null
  );
});

// ---------------------------------------------------------------------------
// reconcileDispositionIdle — the write wrapper
// ---------------------------------------------------------------------------

// A scripted stand-in for the pg pool: getOpenSession uses pool.query(); the
// transition uses pool.connect() + a transactional client.
function fakePool(openRow) {
  const calls = [];
  return {
    calls,
    pool: {
      query: async (sql) => { calls.push(['pool.query', sql]); return { rows: openRow ? [openRow] : [] }; },
      connect: async () => ({
        query: async (sql, params) => {
          calls.push(['client.query', sql, params]);
          if (/SELECT id, session_id, state, started_at/.test(sql)) {
            return { rows: openRow ? [openRow] : [] };
          }
          if (/INSERT INTO fro_time_sessions/.test(sql)) {
            return { rows: [{ id: 9, session_id: 'sess' }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
    },
  };
}

const openWorking = { id: 1, session_id: 'sess', state: TIME_STATES.WORKING, started_at: iso(START) };

test('reconcile moves an open WORKING interval to IDLE at the deadline', async () => {
  const { pool, calls } = fakePool(openWorking);
  const res = await reconcileDispositionIdle({
    workerId: 'w1', liveRow: liveRow(), shift: SHIFT, nowMs: NOW, pool,
  });
  assert.equal(res.changed, true);
  assert.equal(res.idleSinceMs, DUE);

  const insert = calls.find(([kind, sql]) => kind === 'client.query' && /INSERT INTO fro_time_sessions/.test(sql));
  assert.ok(insert, 'an IDLE interval must be inserted');
  assert.equal(insert[2][2], TIME_STATES.IDLE);
  assert.equal(insert[2][3], iso(DUE), 'idle must start at the deadline, not now');
});

test('reconcile is a no-op when the ledger has no open interval', async () => {
  const { pool, calls } = fakePool(null);
  const res = await reconcileDispositionIdle({ workerId: 'w1', liveRow: liveRow(), shift: SHIFT, nowMs: NOW, pool });
  assert.equal(res.changed, false);
  assert.equal(calls.some(([, sql]) => /INSERT INTO fro_time_sessions/.test(sql)), false);
});

test('reconcile is a no-op when the worker is already held or idle', async () => {
  for (const state of [TIME_STATES.IDLE, TIME_STATES.MEETING, TIME_STATES.PAUSED, TIME_STATES.INTERNET_PROBLEM, TIME_STATES.HIDDEN]) {
    const { pool, calls } = fakePool({ ...openWorking, state });
    const res = await reconcileDispositionIdle({ workerId: 'w1', liveRow: liveRow(), shift: SHIFT, nowMs: NOW, pool });
    assert.equal(res.changed, false, `${state} must not be reconciled`);
    assert.equal(calls.some(([, sql]) => /INSERT INTO fro_time_sessions/.test(sql)), false, `${state} must write nothing`);
  }
});

test('reconcile tolerates an unavailable ledger without throwing', async () => {
  const pool = { query: async () => { throw new Error('relation does not exist'); } };
  const res = await reconcileDispositionIdle({ workerId: 'w1', liveRow: liveRow(), shift: SHIFT, nowMs: NOW, pool });
  assert.equal(res.changed, false);
  assert.equal(res.ledgerUnavailable, true);
});

// ---------------------------------------------------------------------------
// transition({ fromState }) — the compare-and-set guard
// ---------------------------------------------------------------------------

test('transition with fromState skips when the open state does not match', async () => {
  const { pool, calls } = fakePool(openWorking);
  const res = await transition('w1', TIME_STATES.IDLE, { atMs: NOW, fromState: TIME_STATES.MEETING, pool });
  assert.equal(res.changed, false);
  assert.equal(res.skipped, true);
  assert.equal(calls.some(([, sql]) => /INSERT INTO fro_time_sessions/.test(sql)), false);
});

test('transition with fromState proceeds when the open state matches', async () => {
  const { pool } = fakePool(openWorking);
  const res = await transition('w1', TIME_STATES.IDLE, { atMs: NOW, fromState: TIME_STATES.WORKING, pool });
  assert.equal(res.changed, true);
});

test('transition with fromState must not invent a session when none is open', async () => {
  const { pool } = fakePool(null);
  const res = await transition('w1', TIME_STATES.IDLE, { atMs: NOW, fromState: TIME_STATES.WORKING, pool });
  assert.equal(res.changed, false);
  assert.equal(res.skipped, true);
});
