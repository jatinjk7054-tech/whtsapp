import {
  getSettings,
  setSettings,
  getPeopleAllocations,
  setPeopleAllocations,
  getSalaryAllocations,
  setSalaryAllocations,
  generateSalaryAllocations,
  generateAllSalaryAllocations,
  listPayments,
  createPayment,
  updatePaymentStatus,
  getNgoSalaryReport,
  getEmployeeReport,
  getNgoReport,
  getSummary,
} from '../models/ngoAllocationModel.js';
import { getWorkerById } from '../models/workerModel.js';
import { getActiveSalaryByWorker } from '../models/salaryModel.js';

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const cleanAllocations = (raw) =>
  (Array.isArray(raw) ? raw : []).filter((a) => a && a.ngo_id);

function validatePeopleAllocations(allocations) {
  if (allocations.length === 0) {
    return { valid: false, message: 'At least one NGO allocation is required' };
  }
  const total = allocations.reduce((sum, a) => sum + round2(a.allocation_percentage), 0);
  if (Math.abs(total - 100) > 0.5) {
    return { valid: false, message: `Allocation percentages (${total}%) must sum to ~100%` };
  }
  for (const a of allocations) {
    if (round2(a.allocation_percentage) < 0) {
      return { valid: false, message: 'Allocation percentages cannot be negative' };
    }
  }
  return { valid: true };
}

function validateSalaryAllocations(allocations, salary) {
  if (allocations.length === 0) {
    return { valid: false, message: 'At least one salary allocation is required' };
  }
  const totalAmount = allocations.reduce((sum, a) => sum + round2(a.allocation_amount), 0);
  if (Math.abs(totalAmount - salary) > 0.01) {
    return { valid: false, message: `Allocation amounts (${totalAmount}) must sum to the salary (${salary})` };
  }
  for (const a of allocations) {
    if (round2(a.allocation_amount) < 0) {
      return { valid: false, message: 'Allocation amounts cannot be negative' };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const getNgoSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const putNgoSettings = async (req, res) => {
  try {
    const allocations = cleanAllocations(req.body.allocations);
    const total = allocations.reduce((sum, a) => sum + round2(a.allocation_percentage), 0);
    if (allocations.length === 0) {
      return res.status(400).json({ message: 'At least one allocation is required' });
    }
    if (Math.abs(total - 100) > 0.5) {
      return res.status(400).json({ message: `Allocation percentages (${total}%) must sum to ~100%` });
    }
    for (const a of allocations) {
      if (round2(a.allocation_percentage) < 0) {
        return res.status(400).json({ message: 'Allocation percentages cannot be negative' });
      }
    }
    const data = await setSettings(allocations);
    return res.json({ message: 'Allocation settings updated', settings: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// People allocations
// ---------------------------------------------------------------------------
export const getWorkerPeople = async (req, res) => {
  try {
    await getWorkerById(req.params.id);
    const data = await getPeopleAllocations(req.params.id);
    return res.json(data);
  } catch (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Worker not found' });
    return res.status(500).json({ message: error.message });
  }
};

export const putWorkerPeople = async (req, res) => {
  try {
    await getWorkerById(req.params.id);
    const allocations = cleanAllocations(req.body.allocations);
    const v = validatePeopleAllocations(allocations);
    if (!v.valid) return res.status(400).json({ message: v.message });
    const data = await setPeopleAllocations(req.params.id, allocations);
    return res.json({ message: 'NGO allocation updated', allocations: data });
  } catch (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Worker not found' });
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Salary allocations
// ---------------------------------------------------------------------------
export const getWorkerSalaryAlloc = async (req, res) => {
  try {
    await getWorkerById(req.params.id);
    const month = req.query.month || null;
    const data = await getSalaryAllocations(req.params.id, month);
    const salary = await getActiveSalaryByWorker(req.params.id);
    return res.json({ month: data.length ? data[0].salary_month : null, salary: salary?.salary || null, allocations: data });
  } catch (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Worker not found' });
    return res.status(500).json({ message: error.message });
  }
};

export const putWorkerSalaryAlloc = async (req, res) => {
  try {
    await getWorkerById(req.params.id);
    const salary = await getActiveSalaryByWorker(req.params.id);
    if (!salary || parseFloat(salary.salary) <= 0) {
      return res.status(400).json({ message: 'This employee has no active salary — set one first in Payroll' });
    }
    const month = req.query.month || req.body.month || null;
    const allocations = cleanAllocations(req.body.allocations).map(a => ({
      ...a,
      allocation_amount: round2(a.allocation_amount),
      allocation_percentage: a.allocation_percentage != null
        ? round2(a.allocation_percentage)
        : (parseFloat(salary.salary) > 0 ? Math.round((round2(a.allocation_amount) / parseFloat(salary.salary)) * 10000) / 100 : 0),
    }));
    const v = validateSalaryAllocations(allocations, parseFloat(salary.salary));
    if (!v.valid) return res.status(400).json({ message: v.message });
    const data = await setSalaryAllocations(req.params.id, month, allocations);
    return res.json({ message: 'Salary allocation updated', allocations: data });
  } catch (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Worker not found' });
    if (error.code === 'PAST_MONTH_LOCKED') return res.status(409).json({ message: error.message });
    return res.status(500).json({ message: error.message });
  }
};

export const postGenerateSalaryAlloc = async (req, res) => {
  try {
    await getWorkerById(req.params.id);
    const month = req.query.month || null;
    const data = await generateSalaryAllocations(req.params.id, month);
    return res.json({ message: 'Salary allocation generated', allocations: data });
  } catch (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Worker not found' });
    if (error.code === 'NO_ACTIVE_SALARY' || error.code === 'NO_ALLOCATIONS') return res.status(400).json({ message: error.message });
    if (error.code === 'EXISTS') return res.status(409).json({ message: error.message });
    return res.status(500).json({ message: error.message });
  }
};

export const postGenerateAllSalaryAlloc = async (req, res) => {
  try {
    const month = req.query.month || null;
    const generated = await generateAllSalaryAllocations(month);
    return res.json({ message: `Generated ${generated} salary allocation(s)`, generated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export const getPayments = async (req, res) => {
  try {
    const { month, ngo_id, worker_id, status } = req.query;
    const data = await listPayments({ month, ngo_id, worker_id, status });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const postPayment = async (req, res) => {
  try {
    const { worker_id, ngo_id, amount, salary_month, payment_reference, payment_status, salary_allocation_id } = req.body;
    if (!worker_id || !ngo_id) {
      return res.status(400).json({ message: 'worker_id and ngo_id are required' });
    }
    if (!(parseFloat(amount) > 0)) {
      return res.status(400).json({ message: 'amount must be greater than 0' });
    }
    if (!salary_month) {
      return res.status(400).json({ message: 'salary_month is required (YYYY-MM)' });
    }
    const result = await createPayment({
      worker_id,
      ngo_id,
      amount,
      salary_month,
      payment_reference,
      payment_status,
      salary_allocation_id,
      created_by: req.user?.id || null,
    });
    return res.status(201).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const putPaymentStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'status is required' });
    const data = await updatePaymentStatus(req.params.id, status);
    return res.json({ message: 'Payment status updated', payment: data });
  } catch (error) {
    if (error.code === 'INVALID_STATUS') return res.status(400).json({ message: error.message });
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Payment not found' });
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export const getReportNgoSalary = async (req, res) => {
  try {
    const { month, ngo_id, worker_id, status } = req.query;
    const data = await getNgoSalaryReport({ month, ngo_id, worker_id, status });
    return res.json({ month: req.query.month || null, rows: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getReportEmployee = async (req, res) => {
  try {
    await getWorkerById(req.params.workerId);
    const data = await getEmployeeReport(req.params.workerId, req.query.month);
    return res.json(data);
  } catch (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ message: 'Worker not found' });
    return res.status(500).json({ message: error.message });
  }
};

export const getReportNgo = async (req, res) => {
  try {
    const data = await getNgoReport(req.params.ngoId, req.query.month);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
export const getNgoSalarySummary = async (req, res) => {
  try {
    const data = await getSummary();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
