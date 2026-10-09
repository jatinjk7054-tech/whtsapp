import {
  applyLoan,
  getWorkerLoans,
  getAllLoans,
  getPendingLoans,
  getLoanById,
  updateLoan,
  deleteLoan,
  getActiveLoansByWorker,
  createDeduction,
  getDeductionsByLoan,
  getTotalDeductedByLoanIds,
  settleMonthlyLoanDeductions,
} from '../models/loanModel.js';
import { notifyNgoAdmins } from '../services/adminNotifyService.js';
import { monthStartOf, normalizeMonth as normalizeMonthValue, termError as loanTermError } from '../utils/loanTerm.js';

const currentMonthStart = () => monthStartOf();

export const apply = async (req, res) => {
  try {
    let { type, amount, reason } = req.body;
    const workerId = req.user.id;

    // Default to 'advance' for the /api/advances/apply endpoint (Flutter app)
    if (!type && req.baseUrl === '/api/advances') {
      type = 'advance';
    }

    if (!type || !amount || !reason || !reason.trim()) {
      return res.status(400).json({ message: 'type, amount, and reason are required' });
    }

    if (!['advance', 'loan'].includes(type)) {
      return res.status(400).json({ message: 'type must be advance or loan' });
    }

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    const record = {
      worker_id: workerId,
      type,
      total_amount: parsed,
      remaining_amount: parsed,
      reason: reason.trim(),
      status: 'pending',
    };

    const result = await applyLoan(record);
    const workerName = req.user?.name || `Worker ${workerId}`;
    await notifyNgoAdmins(
      req.user?.ngo_id,
      'New advance request',
      `${workerName} requested a ${type} of ${parsed}`,
      'loan',
      result?.id
    );
    return res.status(201).json({ message: `${type} request submitted`, loan: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createLoan = async (req, res) => {
  try {
    let { worker_id, type, amount, total_amount, monthly_deduction, reason, start_month, end_month, recurring } = req.body;

    const isRecurring = recurring === true || recurring === 'true' || recurring === 1;
    const total = parseFloat(total_amount !== undefined ? total_amount : amount);
    if (!worker_id) {
      return res.status(400).json({ message: 'worker_id is required' });
    }
    if (!type || !['advance', 'loan'].includes(type)) {
      return res.status(400).json({ message: 'type must be advance or loan' });
    }
    if (isNaN(total) || total <= 0) {
      return res.status(400).json({ message: 'Invalid total_amount' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: 'reason is required' });
    }

    const monthly = parseFloat(monthly_deduction);
    if (isNaN(monthly) || monthly <= 0) {
      return res.status(400).json({ message: 'monthly_deduction is required and must be > 0' });
    }
    if (!isRecurring && monthly > total) {
      return res.status(400).json({ message: 'monthly_deduction cannot exceed total_amount' });
    }

    const termMessage = loanTermError(start_month, end_month);
    if (termMessage) {
      return res.status(400).json({ message: termMessage });
    }

    // Recurring: keeps remaining_amount constant and never auto-closes. Non-recurring:
    // remaining_amount = total and decrements to zero (then closes).
    const remaining = isRecurring ? total : total;

    const record = {
      worker_id,
      type,
      total_amount: total,
      remaining_amount: remaining,
      monthly_deduction: monthly,
      reason: String(reason).trim(),
      start_month: start_month || null,
      end_month: end_month || null,
      recurring: isRecurring,
      status: 'active',
      applied_at: new Date().toISOString(),
      decided_at: new Date().toISOString(),
      decided_by: req.user?.id || null,
    };

    const result = await applyLoan(record);

    try {
      const { getWorkerById } = await import('../models/workerModel.js');
      const worker = await getWorkerById(worker_id);
      await notifyNgoAdmins(
        worker?.ngo_id,
        'Loan / advance recorded',
        `A ${type} of ${total} was recorded for ${worker?.name || `worker ${worker_id}`}`,
        'loan',
        result?.id
      );
    } catch (err) {
      console.error('Manual loan notification skipped:', err.message);
    }

    return res.status(201).json({ message: `${type} created and activated`, loan: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const myLoans = async (req, res) => {
  try {
    const loans = await getWorkerLoans(req.user.id);
    return res.json(loans);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAll = async (req, res) => {
  try {
    let loans = await getAllLoans();
    const ngoId = req.user.role === 'hr' ? null : (req.user.ngo_id || req.query.ngo_id);
    if (ngoId) {
      const { getAllWorkers } = await import('../models/workerModel.js');
      const workers = await getAllWorkers(ngoId);
      const workerIds = new Set(workers.map((w) => w.id));
      loans = loans.filter((l) => workerIds.has(l.worker_id));
    }
    try {
      const totals = await getTotalDeductedByLoanIds(loans.map((l) => l.id));
      loans = loans.map((l) => ({ ...l, total_deducted: totals[l.id] || 0 }));
    } catch (err) {
      console.error('Loan deduction enrichment skipped:', err.message);
    }
    return res.json(loans);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listPending = async (req, res) => {
  try {
    let loans = await getPendingLoans();
    const ngoId = req.user.role === 'hr' ? null : (req.user.ngo_id || req.query.ngo_id);
    if (ngoId) {
      const { getAllWorkers } = await import('../models/workerModel.js');
      const workers = await getAllWorkers(ngoId);
      const workerIds = new Set(workers.map((w) => w.id));
      loans = loans.filter((l) => workerIds.has(l.worker_id));
    }
    return res.json(loans);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const decide = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, monthly_deduction, hr_remark } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved or rejected' });
    }

    const existing = await getLoanById(id);
    if (!existing) {
      return res.status(404).json({ message: 'Loan record not found' });
    }
    if (existing.status !== 'pending') {
      return res.status(400).json({ message: `Already ${existing.status}` });
    }

    if (status === 'approved') {
      const ded = parseFloat(monthly_deduction) || 0;
      if (ded <= 0) {
        return res.status(400).json({ message: 'monthly_deduction is required and must be > 0' });
      }
      if (ded > parseFloat(existing.total_amount)) {
        return res.status(400).json({ message: 'monthly_deduction cannot exceed total amount' });
      }

      const result = await updateLoan(id, {
        status: 'active',
        monthly_deduction: ded,
        remaining_amount: existing.total_amount,
        hr_remark: hr_remark || null,
        decided_at: new Date().toISOString(),
        decided_by: req.user?.id || null,
      });
      return res.json({ message: 'Loan approved', loan: result });
    } else {
      const result = await updateLoan(id, {
        status: 'rejected',
        hr_remark: hr_remark || null,
        decided_at: new Date().toISOString(),
        decided_by: req.user?.id || null,
      });
      return res.json({ message: 'Loan rejected', loan: result });
    }
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerLoansHandler = async (req, res) => {
  try {
    const { workerId } = req.params;
    const loans = await getWorkerLoans(workerId);

    const promises = loans.map(async (l) => {
      const deductions = await getDeductionsByLoan(l.id);
      const totalDeducted = deductions.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
      return { ...l, deductions, total_deducted: totalDeducted };
    });

    const enriched = await Promise.all(promises);
    return res.json(enriched);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerActiveLoans = async (req, res) => {
  try {
    const loans = await getActiveLoansByWorker(req.params.workerId);
    return res.json(loans);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const settleMonthly = async (req, res) => {
  try {
    const year = parseInt(req.body.year, 10);
    const month = parseInt(req.body.month, 10);
    const workerId = req.body.worker_id || undefined;

    if (!year || !month || month < 1 || month > 12 || String(year).length !== 4) {
      return res.status(400).json({ message: 'Valid year and month (1-12) are required' });
    }

    const result = await settleMonthlyLoanDeductions({ year, month, workerId });
    return res.json({
      message: `Settlement complete for ${String(year)}-${String(month).padStart(2, '0')}`,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateLoanRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await getLoanById(id);
    if (!existing) {
      return res.status(404).json({ message: 'Loan record not found' });
    }
    if (!['pending', 'active', 'overdue'].includes(existing.status)) {
      return res.status(400).json({ message: `Cannot edit a ${existing.status} loan` });
    }

    // Clear a retired loan. Both reasons zero the balance and close the loan;
    // the label is kept in hr_remark so the history still says why.
    const resolveAs = typeof req.body.resolve === 'string' ? req.body.resolve : null;
    if (resolveAs) {
      if (!['repaid', 'written_off'].includes(resolveAs)) {
        return res.status(400).json({ message: "resolve must be 'repaid' or 'written_off'" });
      }
      if (existing.status === 'pending') {
        return res.status(400).json({ message: 'A pending request has no balance to resolve. Approve or reject it first.' });
      }
      const result = await updateLoan(id, {
        remaining_amount: 0,
        status: 'closed',
        closed_at: new Date().toISOString(),
        hr_remark: `${existing.hr_remark ? `${existing.hr_remark} | ` : ''}${resolveAs === 'repaid' ? 'Marked repaid' : 'Written off'} on ${new Date().toISOString().slice(0, 10)}`,
      });
      return res.json({ message: `Loan ${resolveAs === 'repaid' ? 'marked repaid' : 'written off'}`, loan: result });
    }

    const updates = {};
    if (req.body.recurring !== undefined) {
      updates.recurring = req.body.recurring === true || req.body.recurring === 'true' || req.body.recurring === 1;
    }
    if (req.body.stop_recurring === true || req.body.stop_recurring === 'true' || req.body.stop_recurring === 1) {
      // Stop a recurring (monthly rent) loan: mark end of the last completed
      // month and set status to closed so it drops out of ALL active picks
      // (settlement, salary sheet, payslip) for future months.
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth(), 0);
      updates.end_month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-01`;
      updates.status = 'closed';
      updates.recurring = existing.recurring === true || updates.recurring === true;
    }
    if (req.body.total_amount !== undefined) {
      const total = parseFloat(req.body.total_amount);
      if (isNaN(total) || total <= 0) return res.status(400).json({ message: 'Invalid total_amount' });
      updates.total_amount = total;
      if (req.body.remaining_amount === undefined) {
        const deducted = parseFloat(existing.total_amount || 0) - parseFloat(existing.remaining_amount || 0);
        updates.remaining_amount = Math.max(0, total - deducted);
      }
    }
    if (req.body.monthly_deduction !== undefined) {
      const ded = parseFloat(req.body.monthly_deduction);
      if (isNaN(ded) || ded <= 0) return res.status(400).json({ message: 'Invalid monthly_deduction' });
      updates.monthly_deduction = ded;
    }
    if (req.body.reason !== undefined) {
      updates.reason = String(req.body.reason).trim() || null;
    }
    if (req.body.remaining_amount !== undefined) {
      updates.remaining_amount = Math.max(0, parseFloat(req.body.remaining_amount));
    }
    if (req.body.start_month !== undefined) {
      updates.start_month = normalizeMonthValue(req.body.start_month);
    }
    if (req.body.end_month !== undefined && req.body.stop_recurring !== true) {
      updates.end_month = normalizeMonthValue(req.body.end_month);
    }

    // Extending an overdue loan past the current month brings it back into the
    // live set, so the next settlement run can deduct it again. Without this a
    // retired loan could only ever be written off, never rescheduled.
    if (updates.end_month && updates.end_month >= currentMonthStart() && existing.status === 'overdue') {
      updates.status = 'active';
    }

    // Only validate the term when end_month is actually being changed. An
    // overdue loan carries an end_month in the past by definition, so
    // re-validating an untouched value would block every other edit to it.
    if (updates.end_month !== undefined && updates.end_month && updates.end_month !== existing.end_month) {
      const termMessage = loanTermError(
        updates.start_month !== undefined ? updates.start_month : existing.start_month,
        updates.end_month
      );
      if (termMessage) {
        return res.status(400).json({ message: termMessage });
      }
    }

    // Validation: recurring loans may deduct the full amount monthly (rent),
    // so the "monthly cannot exceed total" rule only applies to non-recurring.
    if (updates.monthly_deduction !== undefined && updates.total_amount !== undefined) {
      if (!(existing.recurring === true || updates.recurring === true) && updates.monthly_deduction > updates.total_amount) {
        return res.status(400).json({ message: 'monthly_deduction cannot exceed total_amount' });
      }
    } else if (updates.monthly_deduction !== undefined) {
      if (!(existing.recurring === true || updates.recurring === true) && updates.monthly_deduction > parseFloat(existing.total_amount)) {
        return res.status(400).json({ message: 'monthly_deduction cannot exceed total_amount' });
      }
    } else if (updates.total_amount !== undefined) {
      if (!(existing.recurring === true || updates.recurring === true) && parseFloat(existing.monthly_deduction) > updates.total_amount) {
        return res.status(400).json({ message: 'monthly_deduction exceeds new total_amount' });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    const result = await updateLoan(id, updates);
    return res.json({ message: 'Loan updated', loan: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteLoanRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await getLoanById(id);
    if (!existing) {
      return res.status(404).json({ message: 'Loan record not found' });
    }

    if (['active', 'closed'].includes(existing.status) && !req.body?.force) {
      return res.status(400).json({
        message: `This loan is ${existing.status}. Pass { force: true } to delete anyway (prior deductions remain in settlement history).`,
      });
    }

    await deleteLoan(id);
    return res.json({ message: 'Loan deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
