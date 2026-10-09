// THE answer to "what is this FRO's collection target for month M, and where did
// it come from", for every surface that shows one.
//
// WHY THIS EXISTS. The rule was open-coded in three places and the copies had
// drifted:
//
//   - froController.getMyTarget / getMyDashboard — auto beat any stored row
//   - ngoAdminController.getTargets — its own monthsEmployed arithmetic
//   - ngoAdminController.setTarget — a third copy, which also overwrote whatever
//     amount the person typing it had entered
//
// The counting differed too. The two FRO-side copies went through
// monthsSinceJoining (0-based, with a day-of-month adjustment), the admin-side
// copies recomputed the same subtraction inline with no day adjustment and
// anchored it to the target month instead of now. A FRO who joined on the 20th
// was therefore shown 2.5x on their own panel and 3x on the admin board in the
// same third month — one person, two different targets, both correct by the code
// that produced them.
//
// THE PRECEDENCE, and the two decisions encoded in it:
//
//   1. A row for month M wins over the auto value. HR/Accounts edit these, and an
//      edit that is silently discarded because someone is in their first three
//      months is worse than a slightly wrong auto number.
//   2. A row from an EARLIER month does NOT win over the auto value. The table
//      accumulates history, and a new joiner can be sitting on a row that an
//      admin set months ago. Seven of the eight first-three-month FROs in the
//      live table had exactly such a stale row; treating "any row" as an override
//      would have replaced their 2.5x/3x with a figure nobody intended for them.
//      So the override is scoped to month M precisely.
//   3. Month 4+ has no auto value, so the month-M row is used, else the most
//      recent earlier row is carried forward. That is what keeps an established
//      FRO from reading "No target set" on the 1st of every month, which is what
//      used to zero their leaderboard rank and grey them out of the NGO board.
//
// Pure and dependency-free on the decision itself so it is unit-testable without
// a database, following the same split froLiveWindow.buildLiveWindow uses.

import { calculateAutoTarget, monthsSinceJoining, autoTargetMonthLabel } from './froAutoTarget.js';

export const TARGET_SOURCE = {
  AUTO: 'auto',
  MANUAL: 'manual',
  CARRIED_FORWARD: 'carried_forward',
  NOT_SET: 'not_set',
};

function amountOf(row) {
  if (!row) return null;
  const n = Number(row.target_amount);
  return Number.isFinite(n) ? n : null;
}

// pg returns a DATE as either a string or a Date depending on the column parser,
// so normalise before reporting which month a row came from.
function monthOf(row) {
  if (!row || row.month == null) return null;
  const v = row.month instanceof Date ? row.month.toISOString() : String(row.month);
  return v.slice(0, 10);
}

function achievedOf(row) {
  if (!row || row.achieved_target == null) return null;
  const n = Number(row.achieved_target);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve one FRO's target for one month.
 *
 * @param {object}  opts
 * @param {string}  opts.joiningDate  workers.created_at
 * @param {number}  opts.salary       current active salary, 0 when unknown
 * @param {object?} opts.currentRow   fro_monthly_targets row for this month, if any
 * @param {object?} opts.priorRow     most recent fro_monthly_targets row for an EARLIER month
 * @param {Date}    [opts.refDate]    "now" for the tenure calculation
 *
 * @returns {{ target:number, source:string, sourceMonth:?string, achievedTarget:?number,
 *             autoTarget:?number, autoMonthLabel:?string, monthsEmployed:?number }}
 */
export function resolveMonthlyTarget({
  joiningDate,
  salary = 0,
  currentRow = null,
  priorRow = null,
  refDate = new Date(),
} = {}) {
  const monthsEmployed = monthsSinceJoining(joiningDate, refDate);
  const autoTarget = calculateAutoTarget(Number(salary) || 0, monthsEmployed);

  const currentAmount = amountOf(currentRow);
  const base = {
    autoTarget: autoTarget == null ? null : autoTarget,
    autoMonthLabel: autoTargetMonthLabel(monthsEmployed),
    monthsEmployed,
  };

  // Rule 1: an edit for THIS month overrides the auto value.
  if (currentRow && currentAmount != null) {
    return {
      ...base,
      target: currentAmount,
      source: TARGET_SOURCE.MANUAL,
      sourceMonth: monthOf(currentRow),
      // Achievement is never inherited from a carried-forward month: last month
      // hitting target says nothing about this month.
      achievedTarget: achievedOf(currentRow),
    };
  }

  // Rule 2: a stale row does not override auto.
  if (autoTarget != null) {
    return {
      ...base,
      target: autoTarget,
      source: TARGET_SOURCE.AUTO,
      sourceMonth: null,
      achievedTarget: achievedOf(currentRow),
    };
  }

  // Rule 3: month 4+ — this month, else carry the last one forward.
  const priorAmount = amountOf(priorRow);
  if (priorRow && priorAmount != null) {
    return {
      ...base,
      target: priorAmount,
      source: TARGET_SOURCE.CARRIED_FORWARD,
      sourceMonth: monthOf(priorRow),
      achievedTarget: achievedOf(currentRow),
    };
  }

  return {
    ...base,
    target: 0,
    source: TARGET_SOURCE.NOT_SET,
    sourceMonth: null,
    achievedTarget: achievedOf(currentRow),
  };
}