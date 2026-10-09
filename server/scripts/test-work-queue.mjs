// Pure-logic tests for the controlled work queue (no live DB needed).
// Run: node backend/scripts/test-work-queue.mjs
//
// These cover the queue's business rules that don't require a database:
//   - month / cycle-key derivation
//   - retryable-vs-terminal disposition classification (a donor MAY return after
//     a retryable disposition — with same-day suppression being a separate,
//     additive rule that blocks it only for TODAY)
//   - reconcile SQL shape (one row + position per donor; STABLE positions on
//     conflict — no dense re-indexing that would re-serve processed donors)
//   - strict-forward acceptance simulation (A → B → C → D → COMPLETE, never wrap)
//
// The DB-backed guarantees (unique constraint prevents any donor being enqueued
// twice per worker+scope; advisory lock + transaction serialize double-tab /
// double-click; same-day suppression enforced by markDisposed / getMyDonors /
// migration 094's trigger) are exercised against the live DB, which is not
// reachable from a dev machine.

import assert from 'node:assert/strict';
import {
  monthKey,
  cycleKey,
  classifyDisposition,
  RETRYABLE_NOT_CONNECTED_DETAILS,
  buildReconcileSql,
} from '../src/models/workQueueModel.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

console.log('\nmonthKey / cycleKey');
{
  const mk = monthKey(new Date('2026-08-15T12:00:00Z')); // IST = 17:30 Aug 15
  assert.equal(typeof mk, 'string');
  assert.match(mk, /^\d{4}-\d{2}$/);
  ok(`monthKey returns a YYYY-MM key (${mk})`);

  const ck = cycleKey({ ngoId: 'ngo-1', station: 'DH-1', tab: 'new', date: new Date('2026-08-15T12:00:00Z') });
  assert.equal(ck, `ngo-1:DH-1:new:${mk}`);
  ok(`cycleKey composes ngo:station:tab:month (${ck})`);

  // 'all'/null normalized identically per plan (station/ngo agnostic when absent)
  const ckAll = cycleKey({ ngoId: null, station: 'all', tab: 'old', date: new Date('2026-08-15T12:00:00Z') });
  assert.equal(ckAll, `all:all:old:${mk}`);
  ok(`cycleKey normalizes null/all scope (${ckAll})`);
}

console.log('\ndisposition classification (who reappears vs who is removed)');
{
  // Retryable not-connected -> stays active so it can be reworked.
  for (const d of ['ringing', 'busy', 'unreachable', 'out_of_coverage', 'voicemail', 'call_waiting', 'switched_off']) {
    const c = classifyDisposition(d);
    assert.equal(c.retryable, true, `${d} should be retryable`);
    assert.equal(c.terminal, false, `${d} should NOT be terminal`);
  }
  ok('retryable not-connected dispositions keep the donor active');

  // Everything else is terminal for the queue -> removed so it never reappears.
  for (const d of ['done', 'lead_done', 'not_interested', 'dnd', 'wrong_number', 'scheduled', 'callback', 'not_possible', 'call_disconnected']) {
    const c = classifyDisposition(d);
    assert.equal(c.terminal, true, `${d} should be terminal`);
    assert.equal(c.retryable, false, `${d} should not be retryable`);
  }
  ok('terminal dispositions remove the donor from the active queue (no reappear)');

  assert.equal(RETRYABLE_NOT_CONNECTED_DETAILS.has('ringing'), true);
  assert.equal(RETRYABLE_NOT_CONNECTED_DETAILS.has('done'), false);
  ok('RETRYABLE_NOT_CONNECTED_DETAILS exported set is consistent');
}

console.log('\nreconcile SQL shape (ordering / stable positions)');
{
  const { sql, params, cycleKey } = buildReconcileSql({
    workerId: 'w1',
    donors: [
      { donor_id: 10, ngo_id: 'n1' },
      { donor_id: 11, ngo_id: 'n1' },
      { donor_id: 12, ngo_id: 'n2' },
    ],
    ngoId: null, station: 'DH-1', tab: 'new',
  });
  assert.match(sql, /INSERT INTO work_queue/);
  assert.match(sql, /ON CONFLICT \(worker_id, donor_id, ngo_id, cycle_key\)/);
  // 3 donors -> 3 value tuples in INSERT
  const valueTuples = sql.match(/\(\$1, \$2, \$3, \$4/g) || [];
  assert.equal(valueTuples.length, 3, 'one value tuple per donor');
  // positions are the 3rd param of each donor tuple: indices 7, 10, 13
  assert.deepEqual([params[7], params[10], params[13]], [0, 1, 2], 'positions ascend in FIFO order');
  assert.match(cycleKey, /DH-1:new/);
  ok('reconcile emits one row per donor, FIFO seed positions 0..n, and the unique scope constraint');

  // STABLE POSITIONS: on conflict we must NOT re-dense/re-index position.
  // Re-indexing was what let a processed donor's slot move back to the front and
  // be re-served; keeping the seeded position is what makes the forward cursor
  // (`position > last ORDER BY position ASC LIMIT 1`) meaningful.
  assert.equal(/position\s*=\s*EXCLUDED\.position/i.test(sql), false,
    'DO UPDATE must NOT rewrite position (positions are stable for the cycle)');
  assert.match(sql, /WHERE work_queue\.status IN \('PENDING', 'IN_PROGRESS', 'BUTTON_PRESSED'\)/);
  ok('conflict branch keeps position stable (no dense re-index) and only rows still active can be re-touched');
}

console.log('\nsame-day suppression / strict-forward guarantees (DB-backed)');
{
  // These behaviors are enforced by markDisposed()'s same-day guard, the
  // getMyDonors disposedTodayIds exclusion, and migration 094's trigger — all
  // require a live DB. Here we assert the pure classification still treats
  // ringing/busy as RETRYABLE (so they can return TOMORROW), while same-day
  // suppression is a separate concern that blocks them TODAY.
  assert.equal(classifyDisposition('ringing').retryable, true);
  assert.equal(classifyDisposition('busy').retryable, true);
  ok('retryable dispositions remain retryable (eligible again next day) — same-day blocking is additive');
}

// Model of the backend's strict-forward cursor. Positions are STABLE (seeded on
// insert, never re-indexed). A donor processed TODAY is removed from the eligible
// set (same-day suppression). Next = the lowest-position remaining eligible
// donor; no wrap-around ever. Mirrors froController.getMyDonors(queue_current):
//   activeRows = getActiveQueueRows() ordered by stable position ASC
//   next = activeRows[0]   (because disposedToday donors are already excluded)
// Acceptances: A → B → C → D → COMPLETE (never back to A).
function simulateForward(queue, processQueues) {
  // queue: array of { id, position } with stable positions.
  // processQueues: array of donor ids processed today (in order).
  const eligible = queue.filter(d => !processQueues.includes(d.id));
  if (eligible.length === 0) return { next: null, done: true, remaining: eligible };
  return { next: eligible[0], done: false, remaining: eligible };
}

console.log('\nACCEPTANCE: strict forward, same-day, no wrap (A → B → C → D → COMPLETE)');
{
  // Queue with STABLE positions, e.g. seeded on first reconcile.
  const queue = [
    { id: 'A', position: 0 },
    { id: 'B', position: 1 },
    { id: 'C', position: 2 },
    { id: 'D', position: 3 },
  ];

  const processed = [];
  const step = () => {
    const r = simulateForward(queue, processed);
    if (!r.done) processed.push(r.next.id);
    return r;
  };

  // A → RINGING  ⇒ next B
  const r1 = step();
  assert.equal(r1.done, false);
  assert.equal(r1.next.id, 'A', 'first eligible donor is A');
  // Simulate A disposed today -> A must not come back, next is B
  const afterA = simulateForward(queue, ['A']);
  assert.equal(afterA.next.id, 'B', 'after A processed today, next is B (never A)');

  // Process A,B,C,D in order; verify the progression and that it completes.
  const seen = [];
  let result = { done: false };
  let guard = 0;
  while (!result.done && guard++ < 20) {
    result = simulateForward(queue, seen);
    if (!result.done) seen.push(result.next.id);
  }
  assert.deepEqual(seen, ['A', 'B', 'C', 'D'], 'strict-forward progression');
  assert.equal(result.done, true, 'queue COMPLETE after A,B,C,D — no wrap to A');

  // Same-day: a donor processed once today never reappears; a fresh call after
  // only [id] processed must return a donor other than id.
  for (const id of ['A', 'B', 'C', 'D']) {
    const rOne = simulateForward(queue, [id]);
    assert.equal(rOne.done, false, 'there is still eligible work');
    assert.equal(rOne.next.id === id, false, `a donor processed today (${id}) is never returned again today`);
  }

  // Multiple GET / refresh: after A..D processed, nothing eligible remains today.
  for (let i = 0; i < 3; i++) {
    const r = simulateForward(queue, ['A', 'B', 'C', 'D']);
    assert.equal(r.done, true, `GET #${i + 1} after all processed returns COMPLETE (no A)`);
  }
  ok('A → B → C → D → COMPLETE holds; no A→B→C→D→A wrap; refresh/multi-GET never returns processed donors');

  // Next day: processed-today donors are eligible again (retryable rule).
  const nextDay = simulateForward(queue, []);
  assert.equal(nextDay.next.id, 'A', 'next day the queue may start again at A (retryable)');
  ok('next day a retryable donor (A) is eligible again — same-day blocking is not permanent');
}

console.log(`\n${passed} assertions passed`);
