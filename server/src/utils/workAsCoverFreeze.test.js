// Freeze policy for a covered-away FRO. The service wrapper does the querying;
// this file pins the decision itself, which is easy to get wrong and expensive
// to get wrong (it silently bills an absent person for idle).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { indexCovers, isCovered, isCoveredAndAway } from './workAs.js';

const coversFor = (...rows) => indexCovers(rows);

// A cover that is active: operator covering target.
const cover = (target, operator) => ({
  target_fro_worker_id: target,
  operator_user_id: operator,
  operator_name: operator === 'f1' ? 'Priya' : 'Riya',
});

test('a covered FRO who has gone quiet is frozen', () => {
  const m = coversFor(cover('f2', 'f1'));
  assert.equal(isCovered(m, 'f2'), true);
  // Their own row stopped refreshing: away, so no idle may accrue.
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f2', isSelfFresh: () => false }), true);
});

test('a covered FRO who is still refreshing their own row is NOT frozen', () => {
  // Priya covers a station, but the real Riya is at her desk working her own
  // account. Her idle is genuine and must still accrue.
  const m = coversFor(cover('f2', 'f1'));
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f2', isSelfFresh: () => true }), false);
});

test('an uncovered FRO is never frozen, however stale their row', () => {
  const m = coversFor(cover('f2', 'f1'));
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f9', isSelfFresh: () => false }), false);
  assert.equal(isCoveredAndAway({ coversByTarget: coversFor(), targetWorkerId: 'f9', isSelfFresh: () => false }), false);
});

test('a chain judges each person on their own row', () => {
  // Priya covers Riya; the real Riya covers Meera. Riya is covered AND covering.
  // Being covered must not stop Riya's own idle from accruing while she works.
  const m = coversFor(cover('f2', 'f1'), cover('f3', 'f2'));
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f2', isSelfFresh: () => true }), false,
    'Riya is present, so she is not frozen');
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f2', isSelfFresh: () => false }), true,
    'Riya goes quiet while covered, so she is frozen');
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f3', isSelfFresh: () => false }), true,
    'Meera is covered and away, so she is frozen');
  // The operator covering someone is not themselves covered.
  assert.equal(isCovered(m, 'f1'), false);
});

test('several operators covering one person still counts as covered', () => {
  const m = coversFor(cover('f2', 'f1'), cover('f2', 'f3'));
  assert.equal(isCovered(m, 'f2'), true);
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f2', isSelfFresh: () => false }), true);
});

test('a missing liveness probe is treated as present, not away', () => {
  // Fail open on the freeze: if we cannot tell whether the row is live we must
  // not silently stop billing a real idle lapse. Only an explicit false freezes.
  const m = coversFor(cover('f2', 'f1'));
  assert.equal(isCoveredAndAway({ coversByTarget: m, targetWorkerId: 'f2' }), false);
});

test('the frozen test is null-safe on every input', () => {
  assert.equal(isCoveredAndAway({}), false);
  assert.equal(isCoveredAndAway({ coversByTarget: null, targetWorkerId: 'f2', isSelfFresh: () => false }), false);
  assert.equal(isCoveredAndAway({ coversByTarget: coversFor(cover('f2', 'f1')), targetWorkerId: null, isSelfFresh: () => false }), false);
});
