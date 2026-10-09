// Pure loan-term helpers.
//
// Deliberately free of any db import: the rules below decide whether a loan may
// be created, whether it counts as outstanding, and whether a settlement month
// may touch it. Keeping them side-effect free means the exact rules that caused
// expired loans to stay "active" forever can be unit tested without a database.

// First day of the month `now` falls in, as 'YYYY-MM-01'. start_month and
// end_month are DATE columns pinned to the 1st, so string comparison is enough.
export const monthStartOf = (now = new Date()) => {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

// 'YYYY-MM' -> 'YYYY-MM-01'. Anything already dated or empty is passed through.
export const normalizeMonth = (value) => {
  if (value && /^\d{4}-\d{2}$/.test(String(value))) return `${value}-01`;
  return value || null;
};

// Normalises a JS Date to a plain 'YYYY-MM-DD' string. DATE columns are read
// back as raw strings (see the pg type parser in config/db.js), but callers
// occasionally hand us a Date, and `new Date(...)` formats would otherwise leak
// a full ISO timestamp into a comparison.
export const toDateString = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
};

// Last calendar day of the month `monthDate` ('YYYY-MM-01') falls in, as
// 'YYYY-MM-DD'. Used to test whether a loan's start is inside the open window.
export const endOfMonth = (monthDate) => {
  const s = toDateString(monthDate);
  if (!s) return null;
  const [y, m] = s.split('-').map(Number);
  if (!y || !m) return null;
  return `${s.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

// A loan is outstanding during [windowStart, windowEnd] when it has already begun
// and has not finished. A null end_month means it runs indefinitely (recurring
// commitments the accounts team stops by hand).
export const isLoanInPeriod = (loan, windowStart, windowEnd) => {
  const start = toDateString(loan?.start_month);
  const end = toDateString(loan?.end_month);
  const from = toDateString(windowStart);
  const to = toDateString(windowEnd);
  if (start && to && start > to) return false;
  if (end && from && end < from) return false;
  return true;
};

// Salary for month M is disbursed on roughly the 10th of M+1, so month M-1 stays
// open for a back-dated deduction until that run happens. Overridable because the
// payroll date is a business decision, not a fact about the calendar.
export const PAYROLL_PAYMENT_DAY = 10;

// The earliest month a deduction can still be recovered from.
//
// This must NOT be the plain current calendar month. Comparing against it is
// exactly the original bug in reverse: an entry made on the 5th of the next month
// for a salary that is not paid until the 10th would be rejected, even though it
// is perfectly recoverable. Conversely an entry made after the month was actually
// paid can never be recovered, and that is the case worth rejecting.
export const earliestDeductibleMonth = (now = new Date(), paymentDay = PAYROLL_PAYMENT_DAY) => {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getDate() <= paymentDay) {
    // Last month's payroll has not gone out yet, so it can still absorb a loan.
    return monthStartOf(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  }
  return monthStartOf(d);
};

// The bug this guards: a loan whose whole term is already behind us can never be
// deducted. settlement skips it on the end_month guard for every future month, so
// it keeps status='active' with its full balance and is reported as outstanding
// forever. Returns a message to reject with, or null when the term is fine.
export const termError = (startMonth, endMonth, now = new Date()) => {
  const start = toDateString(normalizeMonth(startMonth));
  const end = toDateString(normalizeMonth(endMonth));
  if (start && end && start > end) {
    return 'start_month must not be after end_month.';
  }
  if (!end) return null;
  const earliest = earliestDeductibleMonth(now);
  if (earliest && end < earliest) {
    return `end_month ${end.slice(0, 7)} is already in the past. Salary for that month has been disbursed, so the deduction can never be recovered and the loan would stay outstanding forever. Use ${earliest.slice(0, 7)} or later.`;
  }
  return null;
};

// Decides what a single settlement month should do with one loan, with no I/O.
//
// `settled` means a deduction already exists for this loan+month (re-running the
// same month must be idempotent, not double-deduct).
export const settlementOutcome = (loan, monthDate, { settled = false } = {}) => {
  const month = toDateString(monthDate);
  if (settled) return { action: 'skip', reason: 'already-settled' };

  const start = toDateString(loan?.start_month);
  const end = toDateString(loan?.end_month);
  if (start && month < start) return { action: 'skip', reason: 'before-start' };
  if (end && month > end) return { action: 'skip', reason: 'after-end' };

  const remaining = parseFloat(loan?.remaining_amount || 0);
  const monthly = parseFloat(loan?.monthly_deduction || 0);
  if (!(monthly > 0)) return { action: 'skip', reason: 'no-deduction' };
  if (!(remaining > 0)) return { action: 'skip', reason: 'nothing-owed' };

  const amount = Math.min(monthly, remaining);

  // Recurring commitments (monthly rent and the like) never amortise: the balance
  // is constant and the loan stays live until someone stops it by hand.
  if (loan?.recurring) {
    return {
      action: 'deduct',
      amount,
      // A later run may already have retired this row; a genuine deduction landing
      // on it is proof it is live again, so bring it back into the live set.
      updates: loan.status === 'overdue' ? { status: 'active' } : {},
    };
  }

  const newRemaining = Math.max(0, remaining - amount);
  return {
    action: 'deduct',
    amount,
    newRemaining,
    updates: {
      remaining_amount: newRemaining,
      // 'closed' once fully repaid, otherwise 'active'. Reaching for
      // loan.status here is what left rows stuck on 'approved' after a partial
      // deduction, and left a back-settled 'overdue' row looking unpaid.
      status: newRemaining <= 0 ? 'closed' : 'active',
    },
  };
};

// What a payslip should show as the loan/advance deduction for one worker, given
// every loan of theirs that is live during that month.
//
// Exists so the payslip, the Pagar export and the Loans "Payroll deduction check"
// cannot drift apart: they once each carried their own copy of this rule, and
// they disagreed (one summed, one overwrote, one ignored the outstanding balance).
//
// A recurring commitment is charged flat every month; a non-recurring loan is
// capped at its remaining balance so the final instalment never claims more than
// is actually owed.
export const projectedLoanDeduction = (loans) => {
  if (!Array.isArray(loans)) return 0;
  let total = 0;
  for (const loan of loans) {
    const monthly = parseFloat(loan?.monthly_deduction || 0);
    if (!(monthly > 0)) continue;
    const remaining = parseFloat(loan?.remaining_amount || 0);
    const amount = loan?.recurring ? monthly : Math.min(monthly, remaining);
    if (amount > 0) total += amount;
  }
  return total;
};
