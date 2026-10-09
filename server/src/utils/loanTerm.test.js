import test from 'node:test';
import assert from 'node:assert/strict';

import {
  monthStartOf,
  normalizeMonth,
  toDateString,
  endOfMonth,
  isLoanInPeriod,
  termError,
  settlementOutcome,
  earliestDeductibleMonth,
  projectedLoanDeduction,
  PAYROLL_PAYMENT_DAY,
} from './loanTerm.js';

const loan = (over = {}) => ({
  id: 'L1',
  status: 'active',
  recurring: false,
  total_amount: 432,
  remaining_amount: 432,
  monthly_deduction: 432,
  start_month: '2026-07-01',
  end_month: '2026-08-01',
  ...over,
});

test('monthStartOf pins to the first of the month', () => {
  assert.equal(monthStartOf(new Date(2026, 8, 15)), '2026-09-01');
  assert.equal(monthStartOf(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(monthStartOf('not-a-date'), null);
});

test('normalizeMonth expands YYYY-MM and passes anything else through', () => {
  assert.equal(normalizeMonth('2026-07'), '2026-07-01');
  assert.equal(normalizeMonth('2026-07-01'), '2026-07-01');
  assert.equal(normalizeMonth(''), null);
  assert.equal(normalizeMonth(null), null);
});

// DATE columns come back as raw strings, but a Date leaking in would stringify
// to a full ISO timestamp and make every comparison silently wrong.
test('toDateString never leaks a full timestamp', () => {
  assert.equal(toDateString('2026-07-01T00:00:00.000Z'), '2026-07-01');
  assert.equal(toDateString(new Date(2026, 6, 1)), '2026-07-01');
  assert.equal(toDateString(new Date('nope')), null);
  assert.equal(toDateString(null), null);
});

test('endOfMonth returns the real last day, including February', () => {
  assert.equal(endOfMonth('2026-02-01'), '2026-02-28');
  assert.equal(endOfMonth('2024-02-01'), '2024-02-29');
  assert.equal(endOfMonth('2026-09-01'), '2026-09-30');
});

test('isLoanInPeriod excludes a loan whose term already ended', () => {
  // Deepak's real row: term 2026-07..2026-08, evaluated during 2026-09.
  assert.equal(isLoanInPeriod(loan(), '2026-09-01', '2026-09-30'), false);
  assert.equal(isLoanInPeriod(loan(), '2026-07-01', '2026-07-31'), true);
  assert.equal(isLoanInPeriod(loan(), '2026-08-01', '2026-08-31'), true);
});

test('isLoanInPeriod excludes a loan that has not started yet', () => {
  assert.equal(isLoanInPeriod(loan(), '2026-05-01', '2026-05-31'), false);
});

test('isLoanInPeriod treats a null end_month as open-ended', () => {
  assert.equal(isLoanInPeriod(loan({ end_month: null }), '2099-01-01', '2099-01-31'), true);
});

test('termError rejects a term that is entirely in the past', () => {
  // The actual defect: this row was created on 2026-09-10 with a term that had
  // already finished, making it impossible to ever deduct.
  const message = termError('2026-07-01', '2026-08-01', new Date(2026, 8, 15));
  assert.ok(message, 'a fully-elapsed term must be rejected');
  assert.match(message, /already in the past/);
});

test('termError allows the current month and anything later', () => {
  const now = new Date(2026, 8, 15);
  assert.equal(termError('2026-09-01', '2026-09-01', now), null);
  assert.equal(termError('2026-08-01', '2026-12-01', now), null);
});

test('termError rejects an inverted range regardless of dates', () => {
  assert.match(termError('2026-12-01', '2026-10-01', new Date(2026, 8, 15)), /must not be after/);
});

test('termError allows an open-ended loan with no end_month', () => {
  assert.equal(termError('2020-01-01', null, new Date(2026, 8, 15)), null);
});

// Salary for month M is paid on the 10th of M+1, so M-1 is still recoverable right
// up to that date. Rejecting it on the plain calendar month is the same class of
// bug as never rejecting at all: it refuses a deduction that would work.
test('the previous month stays open until payroll day', () => {
  assert.equal(earliestDeductibleMonth(new Date(2026, 8, 30)), '2026-09-01', 'on the 30th only September is open');
  assert.equal(earliestDeductibleMonth(new Date(2026, 9, 5)), '2026-09-01', 'on Oct 5 September is still unpaid');
  assert.equal(earliestDeductibleMonth(new Date(2026, 9, 10)), '2026-09-01', 'on Oct 10 it is still open');
  assert.equal(earliestDeductibleMonth(new Date(2026, 9, 11)), '2026-10-01', 'on Oct 11 September has closed');
});

test('termError accepts a prior month while its payroll is still pending', () => {
  // Entered on Oct 5 for a salary not paid until Oct 10.
  const oct5 = new Date(2026, 9, 5);
  assert.equal(termError('2026-09-01', '2026-09-01', oct5), null);
  // Entered on Oct 11, after that salary went out.
  const oct11 = new Date(2026, 9, 11);
  assert.match(termError('2026-09-01', '2026-09-01', oct11), /already in the past/);
});

test('the payroll day is overridable', () => {
  assert.equal(PAYROLL_PAYMENT_DAY, 10);
  assert.equal(earliestDeductibleMonth(new Date(2026, 9, 20), 25), '2026-09-01');
  assert.equal(earliestDeductibleMonth(new Date(2026, 9, 26), 25), '2026-10-01');
});

test('earliestDeductibleMonth rolls back across a year boundary', () => {
  assert.equal(earliestDeductibleMonth(new Date(2027, 0, 5)), '2026-12-01');
});

test('a loan past its end month is skipped, not deducted', () => {
  // The core regression: settling 2026-09 against Deepak's row must do nothing.
  const outcome = settlementOutcome(loan(), '2026-09-01');
  assert.equal(outcome.action, 'skip');
  assert.equal(outcome.reason, 'after-end');
});

test('settling inside the term deducts and closes a fully-repaid loan', () => {
  const outcome = settlementOutcome(loan(), '2026-07-01');
  assert.equal(outcome.action, 'deduct');
  assert.equal(outcome.amount, 432);
  assert.equal(outcome.newRemaining, 0);
  assert.equal(outcome.updates.status, 'closed');
});

test('a partial deduction promotes approved to active', () => {
  // Regression: reusing loan.status here left rows stuck on 'approved' after a
  // partial deduction, so the UI showed "Approved" for a running loan.
  const outcome = settlementOutcome(
    loan({ status: 'approved', total_amount: 1000, remaining_amount: 1000, monthly_deduction: 250 }),
    '2026-07-01'
  );
  assert.equal(outcome.newRemaining, 750);
  assert.equal(outcome.updates.remaining_amount, 750);
  assert.equal(outcome.updates.status, 'active');
});

test('re-running a settled month is idempotent', () => {
  const outcome = settlementOutcome(loan(), '2026-07-01', { settled: true });
  assert.equal(outcome.action, 'skip');
  assert.equal(outcome.reason, 'already-settled');
});

test('a back-settled overdue loan is revived, not left looking unpaid', () => {
  // A later run retired the row; an earlier month is then settled. With a balance
  // still left the loan must come back into the live set, otherwise it reads as
  // unpaid forever. (A back-settlement that repays the final instalment correctly
  // closes instead — that is not a revival.)
  const outcome = settlementOutcome(
    loan({ status: 'overdue', total_amount: 1000, remaining_amount: 1000, monthly_deduction: 250 }),
    '2026-07-01'
  );
  assert.equal(outcome.action, 'deduct');
  assert.equal(outcome.updates.remaining_amount, 750);
  assert.equal(outcome.updates.status, 'active');
});

test('a back-settlement of the last instalment closes the loan', () => {
  const outcome = settlementOutcome(loan({ status: 'overdue' }), '2026-07-01');
  assert.equal(outcome.updates.status, 'closed');
});

test('recurring loans never amortise and never auto-close', () => {
  const outcome = settlementOutcome(
    loan({ recurring: true, total_amount: 5000, remaining_amount: 5000, monthly_deduction: 5000, end_month: null }),
    '2026-09-01'
  );
  assert.equal(outcome.action, 'deduct');
  assert.equal(outcome.amount, 5000);
  assert.equal(outcome.updates.remaining_amount, undefined, 'balance must stay constant');
  assert.equal(outcome.updates.status, undefined, 'must not close itself');
});

test('a recurring loan retired by hand is revived on the next deduction', () => {
  const outcome = settlementOutcome(
    loan({ recurring: true, status: 'overdue', end_month: null, remaining_amount: 5000, monthly_deduction: 5000 }),
    '2026-09-01'
  );
  assert.equal(outcome.updates.status, 'active');
});

test('a loan with nothing owed is skipped', () => {
  assert.equal(settlementOutcome(loan({ remaining_amount: 0 }), '2026-07-01').action, 'skip');
  assert.equal(settlementOutcome(loan({ monthly_deduction: 0 }), '2026-07-01').action, 'skip');
});

test('the deduction is capped at the remaining balance', () => {
  const outcome = settlementOutcome(
    loan({ total_amount: 1000, remaining_amount: 300, monthly_deduction: 500 }),
    '2026-07-01'
  );
  assert.equal(outcome.amount, 300);
  assert.equal(outcome.newRemaining, 0);
});

// The payslip, the Pagar export and the Loans payroll check each used to carry
// their own copy of the projection rule and they disagreed. These lock the single
// shared definition in place.
test('projectedLoanDeduction sums every live loan of a worker', () => {
  // Two live loans used to collapse to whichever row came last.
  assert.equal(
    projectedLoanDeduction([
      loan({ id: 'A', monthly_deduction: 1000, remaining_amount: 1000, recurring: true }),
      loan({ id: 'B', monthly_deduction: 5000, remaining_amount: 5000, recurring: false }),
    ]),
    6000,
  );
});

test('projectedLoanDeduction caps a final instalment at the balance owed', () => {
  // Rs 1000/month against Rs 432 left must never claim 1000.
  assert.equal(
    projectedLoanDeduction([loan({ monthly_deduction: 1000, remaining_amount: 432 })]),
    432,
  );
});

test('projectedLoanDeduction charges a recurring commitment flat', () => {
  // A security deposit never amortises, so the balance is irrelevant.
  assert.equal(
    projectedLoanDeduction([
      loan({ monthly_deduction: 1000, remaining_amount: 1000, recurring: true }),
    ]),
    1000,
  );
});

test('projectedLoanDeduction ignores loans with nothing owed or no instalment', () => {
  assert.equal(
    projectedLoanDeduction([
      loan({ monthly_deduction: 1000, remaining_amount: 0 }),
      loan({ monthly_deduction: 0, remaining_amount: 5000 }),
    ]),
    0,
  );
});

test('projectedLoanDeduction tolerates missing and empty input', () => {
  assert.equal(projectedLoanDeduction(undefined), 0);
  assert.equal(projectedLoanDeduction([]), 0);
});

test('projectedLoanDeduction matches the recorded settlement amount', () => {
  // The projection and the amount settlement actually writes must agree, or the
  // payslip will not line up with the month once it is recorded.
  const l = loan({ monthly_deduction: 1000, remaining_amount: 432 });
  const outcome = settlementOutcome(l, '2026-08-01', { settled: false });
  assert.equal(outcome.action, 'deduct');
  assert.equal(projectedLoanDeduction([l]), outcome.amount);
});
