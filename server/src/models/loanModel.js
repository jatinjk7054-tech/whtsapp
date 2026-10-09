import db from '../config/db.js';
import { endOfMonth, monthStartOf, settlementOutcome } from '../utils/loanTerm.js';

export const applyLoan = async (data) => {
  const { data: result, error } = await db
    .from('worker_loans')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getWorkerLoans = async (workerId) => {
  const { data, error } = await db
    .from('worker_loans')
    .select('*')
    .eq('worker_id', workerId)
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getAllLoans = async () => {
  const { data, error } = await db
    .from('worker_loans')
    .select('*, workers(name, login_id, email, department)')
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getPendingLoans = async () => {
  const { data, error } = await db
    .from('worker_loans')
    .select('*, workers(name, login_id, email, department)')
    .eq('status', 'pending')
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getLoanById = async (id) => {
  const { data, error } = await db
    .from('worker_loans')
    .select('*, workers(name, login_id, email, department)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateLoan = async (id, updates) => {
  const { data, error } = await db
    .from('worker_loans')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteLoan = async (id) => {
  const { error: dedErr } = await db.from('worker_loan_deductions').delete().eq('loan_id', id);
  if (dedErr) throw dedErr;
  const { error } = await db.from('worker_loans').delete().eq('id', id);
  if (error) throw error;
};

// Statuses that mean "this loan is still live and can be deducted from salary".
// Anything outside this set is excluded from every automatic pick, so a loan
// only ever leaves this set deliberately (or by expiring, see expireOverdueLoans).
export const LIVE_LOAN_STATUSES = ['approved', 'active'];

// A loan whose term has fully elapsed can never be settled again: the end_month
// guard in settleMonthlyLoanDeductions skips it for every month after the term,
// so remaining_amount never decreases and status never leaves 'active'. Such a
// row then sits in the live set forever, inflating outstanding-loan figures and
// — because two callers filter on status alone — silently deducted from salary.
//
// expireOverdueLoans moves those rows to the terminal 'overdue' status. The
// balance is deliberately preserved: the money is still owed, it simply cannot
// be auto-deducted because the term is over. That is a decision for accounts,
// not something settlement should silently discard.
//
// Only non-recurring loans are expired. A recurring loan (monthly rent) runs
// until it is explicitly stopped, so its end_month being in the past is not by
// itself a reason to retire it.
export const expireOverdueLoans = async ({ monthDate }) => {
  const { rows, error } = await db._pool.query(
    `UPDATE worker_loans
        SET status = 'overdue', updated_at = now()
      WHERE status = ANY($1)
        AND COALESCE(recurring, FALSE) = FALSE
        AND COALESCE(remaining_amount, 0) > 0
        AND end_month IS NOT NULL
        AND end_month < $2
      RETURNING id, worker_id, total_amount, remaining_amount, monthly_deduction, end_month`,
    [LIVE_LOAN_STATUSES, monthDate]
  );
  if (error) throw error;
  return rows || [];
};

export const getActiveLoansByWorker = async (workerId) => {
  const monthStart = monthStartOf();
  const monthEnd = endOfMonth(monthStart);
  const { data, error } = await db
    .from('worker_loans')
    .select('*')
    .eq('worker_id', workerId)
    .in('status', LIVE_LOAN_STATUSES)
    .gt('remaining_amount', 0)
    .lte('start_month', monthEnd)
    .or(`end_month.is.null,end_month.gte.${monthStart}`);
  if (error) throw error;
  return data || [];
};

// Settlement-only pick, optionally scoped to a single worker. Unlike the
// salary/report picks this deliberately has no period filter, because the caller
// re-checks start_month/end_month per month being settled. 'overdue' is included
// so a back-settled month within the original term still works after a later run
// already retired the loan; the deduction then revives it (see
// settleMonthlyLoanDeductions).
//
// Settling must NOT use getActiveLoansByWorker here: that filters against the
// *current* month, so back-settling a month whose loan term has already ended
// (e.g. recording an August loan in September) would match nothing and silently
// deduct nothing.
export const getLoansForSettlement = async ({ workerId } = {}) => {
  let query = db
    .from('worker_loans')
    .select('*')
    .in('status', [...LIVE_LOAN_STATUSES, 'overdue'])
    .gt('remaining_amount', 0);
  if (workerId) query = query.eq('worker_id', workerId);
  const { data, error } = await query.order('worker_id');
  if (error) throw error;
  return data || [];
};

export const createDeduction = async (loanId, month, amount) => {
  const { data, error } = await db
    .from('worker_loan_deductions')
    .insert([{ loan_id: loanId, month, amount }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getDeductionsForWorkerMonth = async (workerId, month) => {
  const { data, error } = await db
    .from('worker_loan_deductions')
    .select('*, worker_loans!inner(worker_id)')
    .eq('worker_loans.worker_id', workerId)
    .eq('month', month);
  if (error) throw error;
  return data || [];
};

export const getDeductionsByLoan = async (loanId) => {
  const { data, error } = await db
    .from('worker_loan_deductions')
    .select('*')
    .eq('loan_id', loanId)
    .order('month', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getDeductionForLoanMonth = async (loanId, month) => {
  const { data, error } = await db
    .from('worker_loan_deductions')
    .select('*')
    .eq('loan_id', loanId)
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

export const getTotalDeductedByLoanIds = async (loanIds) => {
  if (!loanIds || !loanIds.length) return {};
  const { data, error } = await db
    .from('worker_loan_deductions')
    .select('loan_id, amount')
    .in('loan_id', loanIds);
  if (error) throw error;
  const totals = {};
  for (const r of data || []) {
    totals[r.loan_id] = (totals[r.loan_id] || 0) + parseFloat(r.amount || 0);
  }
  return totals;
};

// Applies the monthly salary deduction for a given month ('YYYY-MM-01') to every
// active loan that does not already have a deduction recorded for that month.
// Idempotent: re-running a month never double-charges. Advances remaining_amount
// by the deduction and closes the loan once the balance reaches zero.
export const settleMonthlyLoanDeductions = async ({ year, month, workerId }) => {
  const monthDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // Retire loans whose term ended before the month being settled. Without this
  // they keep status='active' forever and are still counted as outstanding.
  const expired = await expireOverdueLoans({ monthDate });
  const loans = await getLoansForSettlement({ workerId });

  if (!loans.length) return { settled: 0, skipped: 0, total_deducted: 0, expired: expired.length };

  const { data: existing, error: exErr } = await db
    .from('worker_loan_deductions')
    .select('loan_id')
    .eq('month', monthDate)
    .in('loan_id', loans.map((l) => l.id));
  if (exErr) throw exErr;
  const settledLoanIds = new Set((existing || []).map((r) => r.loan_id));

  let settled = 0;
  let skipped = 0;
  let total_deducted = 0;

  for (const loan of loans) {
    const outcome = settlementOutcome(loan, monthDate, {
      settled: settledLoanIds.has(loan.id),
    });
    if (outcome.action === 'skip') {
      skipped++;
      continue;
    }
    try {
      await createDeduction(loan.id, monthDate, outcome.amount);
    } catch (e) {
      if (/duplicate|unique/i.test(e?.message || '')) {
        skipped++;
        continue;
      }
      throw e;
    }
    await updateLoan(loan.id, outcome.updates);
    settled++;
    total_deducted += outcome.amount;
  }

  return { settled, skipped, total_deducted, expired: expired.length };
};
