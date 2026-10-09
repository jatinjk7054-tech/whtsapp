// The one rule that answers "what is this FRO's target for this month, and where
// did the number come from".
//
// This file exists because the rule was open-coded in three places and the copies
// disagreed. The case that has to keep passing is the subtle one: a first-three-
// month FRO who is sitting on an OLD stored row must still get their derived
// salary tier, not that stale row. In the live table, seven of the eight FROs
// inside their first three months had exactly such a row, so reading "any row
// wins" would have replaced their 1x / 2.5x / 3x with a figure nobody chose for
// them. The override is therefore scoped to the month being displayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveMonthlyTarget, TARGET_SOURCE } from './froMonthlyTarget.js';

const SALARY = 10000;

// monthsSinceJoining reads the LOCAL calendar, so these are built in local time
// to keep the tenure arithmetic unambiguous regardless of the machine's zone.
const joinIn = (yearsAgo, month, day) => new Date(2026 - yearsAgo, month, day).toISOString();
const REF = new Date(2026, 9, 20); // 20 Oct 2026 local

// A joiner who is `months` 0-based months past their joining date at REF.
function joinedMonthsAgo(months) {
  const d = new Date(REF);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

const row = (month, target_amount, achieved_target = null) => ({
  month,
  target_amount,
  achieved_target,
});

test('month 1-3: target is derived from salary when no row exists for this month', () => {
  const cases = [
    { months: 0, expected: SALARY * 1 },
    { months: 1, expected: SALARY * 2.5 },
    { months: 2, expected: SALARY * 3 },
  ];
  for (const { months, expected } of cases) {
    const r = resolveMonthlyTarget({
      joiningDate: joinedMonthsAgo(months),
      salary: SALARY,
      refDate: REF,
    });
    assert.equal(r.target, expected, `months=${months}`);
    assert.equal(r.source, TARGET_SOURCE.AUTO);
    assert.equal(r.sourceMonth, null);
    assert.equal(r.monthsEmployed, months);
  }
});

test('month 1-3: a STALE row from an earlier month does not override the derived tier', () => {
  // The regression this guards. The stored row is for August while we are
  // displaying October; taking it would silently replace 2.5x with 20000.
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(1),
    salary: SALARY,
    currentRow: null,
    priorRow: row('2026-08-01', 20000, 19000),
    refDate: REF,
  });

  assert.equal(r.target, SALARY * 2.5);
  assert.equal(r.source, TARGET_SOURCE.AUTO);
  assert.equal(r.sourceMonth, null);
  // Achievement is never inherited from another month either.
  assert.equal(r.achievedTarget, null);
});

test('month 1-3: a row for THIS month does override the derived tier', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(2),
    salary: SALARY,
    currentRow: row('2026-10-01', 12000, 3400),
    priorRow: row('2026-09-01', 99999),
    refDate: REF,
  });

  assert.equal(r.target, 12000);
  assert.equal(r.source, TARGET_SOURCE.MANUAL);
  assert.equal(r.sourceMonth, '2026-10-01');
  assert.equal(r.achievedTarget, 3400);
  // The derived value is still reported so the UI can explain the tier.
  assert.equal(r.autoTarget, SALARY * 3);
});

test('month 4+: this month\'s row wins', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(5),
    salary: SALARY,
    currentRow: row('2026-10-01', 45000, 41000),
    priorRow: row('2026-09-01', 40000),
    refDate: REF,
  });

  assert.equal(r.target, 45000);
  assert.equal(r.source, TARGET_SOURCE.MANUAL);
  assert.equal(r.sourceMonth, '2026-10-01');
  assert.equal(r.achievedTarget, 41000);
  // Past the auto window there is no derived value to report.
  assert.equal(r.autoTarget, null);
  assert.equal(r.autoMonthLabel, null);
});

test('month 4+ with no row for this month carries the last one forward', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(5),
    salary: SALARY,
    currentRow: null,
    priorRow: row('2026-09-01', 40000, 39000),
    refDate: REF,
  });

  assert.equal(r.target, 40000, 'the figure, not last month\'s achievement');
  assert.equal(r.source, TARGET_SOURCE.CARRIED_FORWARD);
  assert.equal(r.sourceMonth, '2026-09-01', 'the UI can name the month it came from');
  assert.equal(r.achievedTarget, null, 'achievement is never carried forward');
});

test('month 4+ with no history at all is not_set at zero', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(5),
    salary: SALARY,
    refDate: REF,
  });

  assert.equal(r.target, 0);
  assert.equal(r.source, TARGET_SOURCE.NOT_SET);
  assert.equal(r.sourceMonth, null);
});

test('a current row of 0 counts as a deliberate value, not as absent', () => {
  // Someone set the target to zero on purpose (a paused or frozen FRO). Treating
  // that as "no row" would let the derived tier or a carried figure overwrite it.
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(1),
    salary: SALARY,
    currentRow: row('2026-10-01', 0),
    priorRow: row('2026-09-01', 40000),
    refDate: REF,
  });

  assert.equal(r.target, 0);
  assert.equal(r.source, TARGET_SOURCE.MANUAL);
});

test('a prior row of 0 is still carried forward as 0', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(9),
    salary: SALARY,
    priorRow: row('2026-09-01', 0),
    refDate: REF,
  });

  assert.equal(r.target, 0);
  assert.equal(r.source, TARGET_SOURCE.CARRIED_FORWARD);
  assert.equal(r.sourceMonth, '2026-09-01');
});

test('numeric strings from a numeric Postgres column resolve as numbers', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(5),
    salary: SALARY,
    priorRow: { month: '2026-09-01', target_amount: '40000' },
    refDate: REF,
  });

  assert.strictEqual(r.target, 40000);
  assert.equal(typeof r.target, 'number');
});

test('a Date-typed month reports its source month as YYYY-MM-DD', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(5),
    salary: SALARY,
    priorRow: { month: new Date('2026-09-01T00:00:00Z'), target_amount: 40000 },
    refDate: REF,
  });

  assert.equal(r.sourceMonth, '2026-09-01');
});

test('an unusable joining date yields not_set rather than a wrong tier', () => {
  const r = resolveMonthlyTarget({
    joiningDate: 'not-a-date',
    salary: SALARY,
    refDate: REF,
  });

  assert.equal(r.monthsEmployed, null);
  assert.equal(r.autoTarget, null);
  assert.equal(r.source, TARGET_SOURCE.NOT_SET);
  assert.equal(r.target, 0);
});

test('missing salary does not produce a NaN target', () => {
  const r = resolveMonthlyTarget({
    joiningDate: joinedMonthsAgo(1),
    salary: undefined,
    refDate: REF,
  });

  assert.ok(Number.isFinite(r.target), 'target must be a real number');
  assert.equal(r.target, 0);
});