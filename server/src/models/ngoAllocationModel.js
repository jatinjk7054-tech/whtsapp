import db from '../config/db.js';

// ---------------------------------------------------------------------------
// NGO allocation settings (org-wide default/target % per NGO)
// ---------------------------------------------------------------------------
export const getSettings = async () => {
  const { data, error } = await db
    .from('ngo_allocation_settings')
    .select('*, ngos(name, code)')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const setSettings = async (allocations) => {
  return db.transaction(async ({ from }) => {
    const { error: delErr } = await from('ngo_allocation_settings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (delErr) throw delErr;

    if (!allocations || allocations.length === 0) return [];

    const rows = allocations.map(a => ({
      ngo_id: a.ngo_id,
      allocation_percentage: parseFloat(a.allocation_percentage) || 0,
    }));
    const { data, error } = await from('ngo_allocation_settings').insert(rows).select('*, ngos(name, code)');
    if (error) throw error;
    return data;
  });
};

// ---------------------------------------------------------------------------
// People (employment) allocations — percentages summing to 100
// ---------------------------------------------------------------------------
export const getPeopleAllocations = async (workerId) => {
  const { data, error } = await db
    .from('worker_people_allocations')
    .select('*, ngos(name, code)')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const setPeopleAllocations = async (workerId, allocations) => {
  return db.transaction(async ({ from }) => {
    const { error: delErr } = await from('worker_people_allocations').delete().eq('worker_id', workerId);
    if (delErr) throw delErr;

    if (!allocations || allocations.length === 0) return [];

    const rows = allocations.map(a => ({
      worker_id: workerId,
      ngo_id: a.ngo_id,
      allocation_percentage: parseFloat(a.allocation_percentage) || 0,
      effective_from: a.effective_from || null,
      status: 'active',
    }));
    const { data, error } = await from('worker_people_allocations').insert(rows).select('*, ngos(name, code)');
    if (error) throw error;
    return data;
  });
};

// ---------------------------------------------------------------------------
// Salary allocations — monthly snapshots of the rupee split across NGOs
// ---------------------------------------------------------------------------
const monthFirst = (month) => {
  if (!month) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }
  const p = String(month).slice(0, 10).split('-');
  return `${p[0]}-${p[1]}-01`;
};

const isPastMonth = (monthStr) => {
  const d = new Date(monthStr + 'T00:00:00Z');
  const now = new Date();
  const cur = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d < cur;
};

export const getSalaryAllocations = async (workerId, month) => {
  const m = monthFirst(month);
  const { data, error } = await db
    .from('salary_allocations')
    .select('*, ngos(name, code)')
    .eq('worker_id', workerId)
    .eq('salary_month', m)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const setSalaryAllocations = async (workerId, month, allocations) => {
  const m = monthFirst(month);
  if (isPastMonth(m)) {
    const err = new Error('Past months are locked — salary allocations cannot be changed for earlier months');
    err.code = 'PAST_MONTH_LOCKED';
    throw err;
  }
  return db.transaction(async ({ from }) => {
    const { error: delErr } = await from('salary_allocations').delete().eq('worker_id', workerId).eq('salary_month', m);
    if (delErr) throw delErr;

    if (!allocations || allocations.length === 0) return [];

    const rows = allocations.map(a => ({
      worker_id: workerId,
      ngo_id: a.ngo_id,
      salary_month: m,
      allocation_percentage: parseFloat(a.allocation_percentage) || 0,
      allocation_amount: parseFloat(a.allocation_amount) || 0,
      status: 'active',
    }));
    const { data, error } = await from('salary_allocations').insert(rows).select('*, ngos(name, code)');
    if (error) throw error;
    return data;
  });
};

// Generate a salary snapshot for a worker+month from the live payroll split
// (worker_ngo_allocations) and the worker's active salary. Past months that
// already have a snapshot are never overwritten.
export const generateSalaryAllocations = async (workerId, month) => {
  const m = monthFirst(month);

  const { data: salary, error: sErr } = await db
    .from('salary_history')
    .select('*')
    .eq('worker_id', workerId)
    .order('from_month', { ascending: false })
    .limit(1);
  if (sErr) throw sErr;
  const activeSalary = salary && salary.length > 0 ? salary[0] : null;
  if (!activeSalary || parseFloat(activeSalary.salary) <= 0) {
    const err = new Error('This employee has no active salary — set one first in Payroll');
    err.code = 'NO_ACTIVE_SALARY';
    throw err;
  }

  const { data: allocs, error: aErr } = await db
    .from('worker_ngo_allocations')
    .select('*')
    .eq('worker_id', workerId);
  if (aErr) throw aErr;
  if (!allocs || allocs.length === 0) {
    const err = new Error('This employee has no NGO salary split — add one in Payroll');
    err.code = 'NO_ALLOCATIONS';
    throw err;
  }

  const total = parseFloat(activeSalary.salary);
  const rows = allocs.map(a => {
    const amount = parseFloat(a.salary_portion) || 0;
    return {
      worker_id: workerId,
      ngo_id: a.ngo_id,
      salary_month: m,
      allocation_percentage: total > 0 ? Math.round((amount / total) * 10000) / 100 : 0,
      allocation_amount: amount,
      status: 'active',
    };
  });

  return db.transaction(async ({ from }) => {
    const { data: existing, error: exErr } = await from('salary_allocations')
      .select('id')
      .eq('worker_id', workerId)
      .eq('salary_month', m);
    if (exErr) throw exErr;
    if (existing && existing.length > 0) {
      const err = new Error(`Salary allocation already exists for this month — use PUT to update it`);
      err.code = 'EXISTS';
      throw err;
    }
    const { data, error } = await from('salary_allocations').insert(rows).select('*, ngos(name, code)');
    if (error) throw error;
    return data;
  });
};

// Generate salary allocations for ALL active workers for a given month.
// Workers that already have allocations for the month, or have no salary / NGO
// split, are silently skipped.  Returns the count of newly created allocations.
export const generateAllSalaryAllocations = async (month) => {
  const m = monthFirst(month);

  const { data: workers, error: wErr } = await db
    .from('workers')
    .select('id')
    .eq('employment_status', 'active');
  if (wErr) throw wErr;

  const rowsToInsert = [];

  for (const w of workers || []) {
    const { data: existing } = await db
      .from('salary_allocations')
      .select('id')
      .eq('worker_id', w.id)
      .eq('salary_month', m)
      .limit(1);
    if (existing && existing.length > 0) continue;

    const { data: salary } = await db
      .from('salary_history')
      .select('*')
      .eq('worker_id', w.id)
      .order('from_month', { ascending: false })
      .limit(1);
    const activeSalary = salary && salary.length > 0 ? salary[0] : null;
    if (!activeSalary || parseFloat(activeSalary.salary) <= 0) continue;

    const { data: allocs } = await db
      .from('worker_ngo_allocations')
      .select('*')
      .eq('worker_id', w.id);
    if (!allocs || allocs.length === 0) continue;

    const total = parseFloat(activeSalary.salary);
    for (const a of allocs) {
      const amount = parseFloat(a.salary_portion) || 0;
      rowsToInsert.push({
        worker_id: w.id,
        ngo_id: a.ngo_id,
        salary_month: m,
        allocation_percentage: total > 0 ? Math.round((amount / total) * 10000) / 100 : 0,
        allocation_amount: amount,
        status: 'active',
      });
    }
  }

  if (rowsToInsert.length === 0) return 0;

  const { error: insErr } = await db
    .from('salary_allocations')
    .insert(rowsToInsert);
  if (insErr) throw insErr;

  return rowsToInsert.length;
};

// ---------------------------------------------------------------------------
// Salary payments
// ---------------------------------------------------------------------------
const PAYMENT_STATUSES = ['pending', 'processing', 'paid', 'failed', 'cancelled'];

export const listPayments = async ({ month, ngo_id, worker_id, status } = {}) => {
  let q = db
    .from('salary_payments')
    .select('*, workers(name, employee_id), ngos(name, code)')
    .order('created_at', { ascending: false });

  if (month) q = q.eq('salary_month', monthFirst(month));
  if (ngo_id) q = q.eq('ngo_id', ngo_id);
  if (worker_id) q = q.eq('worker_id', worker_id);
  if (status) q = q.eq('payment_status', status);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
};

export const createPayment = async (data) => {
  const { error } = await db
    .from('salary_payments')
    .insert({
      worker_id: data.worker_id,
      ngo_id: data.ngo_id,
      salary_allocation_id: data.salary_allocation_id || null,
      amount: parseFloat(data.amount) || 0,
      salary_month: monthFirst(data.salary_month),
      payment_reference: data.payment_reference || null,
      payment_status: data.payment_status || 'pending',
      created_by: data.created_by || null,
    });
  if (error) throw error;
  return { message: 'Payment created successfully' };
};

export const updatePaymentStatus = async (id, status) => {
  if (!PAYMENT_STATUSES.includes(status)) {
    const err = new Error(`payment_status must be one of: ${PAYMENT_STATUSES.join(', ')}`);
    err.code = 'INVALID_STATUS';
    throw err;
  }
  const updates = { payment_status: status };
  if (status === 'paid') updates.payment_date = new Date().toISOString();
  const { data, error } = await db
    .from('salary_payments')
    .update(updates)
    .eq('id', id)
    .select('*, workers(name, employee_id), ngos(name, code)')
    .single();
  if (error) throw error;
  return data;
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export const getNgoSalaryReport = async ({ month, ngo_id, worker_id, status } = {}) => {
  const m = monthFirst(month);
  let q = db
    .from('salary_allocations')
    .select('*, workers(name, employee_id, department), ngos(name, code)')
    .eq('salary_month', m)
    .order('ngos(name)', { ascending: true });

  if (ngo_id) q = q.eq('ngo_id', ngo_id);
  if (worker_id) q = q.eq('worker_id', worker_id);

  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];

  const { data: payments, error: pErr } = await db
    .from('salary_payments')
    .select('*')
    .eq('salary_month', m);
  if (pErr) throw pErr;

  const payByKey = {};
  for (const p of payments || []) {
    const key = `${p.worker_id}|${p.ngo_id}`;
    if (!payByKey[key]) payByKey[key] = { paid: 0, status: 'unpaid' };
    payByKey[key].paid += parseFloat(p.amount) || 0;
    if (p.payment_status === 'paid' || p.payment_status === 'processing') {
      payByKey[key].status = p.payment_status;
    }
  }

  return rows.map(r => {
    const p = payByKey[`${r.worker_id}|${r.ngo_id}`];
    const amount = parseFloat(r.allocation_amount) || 0;
    let rowStatus = p ? p.status : 'unpaid';
    if (status && rowStatus !== status) return null;
    return {
      worker_id: r.worker_id,
      worker_name: r.workers?.name || 'Unknown',
      employee_id: r.workers?.employee_id || null,
      department: r.workers?.department || null,
      ngo_id: r.ngo_id,
      ngo_name: r.ngos?.name || 'Unknown',
      ngo_code: r.ngos?.code || null,
      salary_month: r.salary_month,
      allocation_percentage: r.allocation_percentage,
      allocation_amount: amount,
      paid_amount: p ? p.paid : 0,
      payment_status: rowStatus,
    };
  }).filter(Boolean);
};

export const getEmployeeReport = async (workerId, month) => {
  let q = db
    .from('salary_allocations')
    .select('*, ngos(name, code)')
    .eq('worker_id', workerId)
    .order('salary_month', { ascending: false });

  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];

  const months = [...new Set(rows.map(r => r.salary_month))];
  const { data: payments, error: pErr } = await db
    .from('salary_payments')
    .select('*')
    .eq('worker_id', workerId);
  if (pErr) throw pErr;

  const payByKey = {};
  for (const p of payments || []) {
    const key = `${p.ngo_id}|${p.salary_month}`;
    if (!payByKey[key]) payByKey[key] = { paid: 0, status: 'unpaid' };
    payByKey[key].paid += parseFloat(p.amount) || 0;
    if (p.payment_status === 'paid' || p.payment_status === 'processing') {
      payByKey[key].status = p.payment_status;
    }
  }

  return {
    worker_id: workerId,
    months,
    rows: rows.map(r => ({
      ...r,
      paid_amount: payByKey[`${r.ngo_id}|${r.salary_month}`]?.paid || 0,
      payment_status: payByKey[`${r.ngo_id}|${r.salary_month}`]?.status || 'unpaid',
    })),
  };
};

export const getNgoReport = async (ngoId, month) => {
  const m = monthFirst(month);
  const { data, error } = await db
    .from('salary_allocations')
    .select('*, workers(name, employee_id)')
    .eq('ngo_id', ngoId)
    .eq('salary_month', m)
    .order('workers(name)', { ascending: true });
  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((s, r) => s + (parseFloat(r.allocation_amount) || 0), 0);
  const count = rows.length;

  const { data: payments, error: pErr } = await db
    .from('salary_payments')
    .select('*')
    .eq('ngo_id', ngoId)
    .eq('salary_month', m);
  if (pErr) throw pErr;

  const paid = (payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const payByWorker = {};
  for (const p of payments || []) {
    if (p.payment_status === 'paid' || p.payment_status === 'processing') {
      payByWorker[p.worker_id] = p.payment_status;
    }
  }

  return {
    ngo_id: ngoId,
    salary_month: m,
    total_employees: count,
    total_amount: total,
    paid_amount: paid,
    pending_amount: Math.max(total - paid, 0),
    rows: rows.map(r => ({
      worker_id: r.worker_id,
      worker_name: r.workers?.name || 'Unknown',
      employee_id: r.workers?.employee_id || null,
      allocation_percentage: r.allocation_percentage,
      allocation_amount: r.allocation_amount,
      payment_status: payByWorker[r.worker_id] || 'unpaid',
    })),
  };
};

// ---------------------------------------------------------------------------
// Summary — header totals for the NGO & Salary page
// ---------------------------------------------------------------------------
export const getSummary = async () => {
  const { count: employees, error: eErr } = await db
    .from('workers')
    .select('*', { count: 'exact', head: true })
    .eq('employment_status', 'active');
  if (eErr) throw eErr;

  const { count: ngoCount, error: nErr } = await db
    .from('ngos')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);
  if (nErr) throw nErr;

  const { data: salaries, error: sErr } = await db
    .from('salary_history')
    .select('*')
    .order('from_month', { ascending: false });
  if (sErr) throw sErr;

  const latest = {};
  for (const s of salaries || []) {
    if (!latest[s.worker_id]) latest[s.worker_id] = s;
  }
  const totalSalary = Object.values(latest).reduce((sum, s) => sum + (parseFloat(s.salary) || 0), 0);

  const m = monthFirst();
  const { data: payments, error: pErr } = await db
    .from('salary_payments')
    .select('*')
    .eq('salary_month', m);
  if (pErr) throw pErr;

  let paid = 0, pending = 0;
  for (const p of payments || []) {
    const amt = parseFloat(p.amount) || 0;
    if (p.payment_status === 'paid' || p.payment_status === 'processing') paid += amt;
    else pending += amt;
  }

  return {
    employees: employees || 0,
    ngos: ngoCount || 0,
    total_salary: Math.round(totalSalary * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    pending: Math.round(pending * 100) / 100,
  };
};
