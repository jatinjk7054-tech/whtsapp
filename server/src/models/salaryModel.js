import db from '../config/db.js';
import { getDayName, calculateAKI, getMonthsEmployed, getAKISlabs } from '../utils/incentive.js';
import { COMPENSATORY_WORKDAYS, computePaidDays, getISTToday } from '../utils/salaryDays.js';
import { normalizeAgentName } from '../utils/workerNameMatch.js';
import { projectedLoanDeduction } from '../utils/loanTerm.js';
import { getSetting, upsertSetting } from './settingsModel.js';
import { LIVE_LOAN_STATUSES } from './loanModel.js';

const SALARY_COMPENSATIONS_KEY = 'accounts_salary_compensations';

// Sums the loan/advance amounts actually recovered in `monthDate` (a
// 'YYYY-MM-01' value) per worker, from the rows written by
// loanModel.settleMonthlyLoanDeductions.
//
// Returns a plain object keyed by worker id. Workers with no recorded deduction
// are simply absent, so callers can distinguish "nothing was recovered" from
// "recovered nothing because no loan exists" and fall back to a projection when
// the month has not been settled yet. A failure here must never blank out a
// payslip, so errors degrade to an empty result and the caller projects instead.
const getRecordedLoanDeductionsForMonth = async (monthDate) => {
  try {
    const { rows, error } = await db._pool.query(
      `SELECT l.worker_id, COALESCE(SUM(d.amount), 0) AS amount
         FROM worker_loan_deductions d
         JOIN worker_loans l ON l.id = d.loan_id
        WHERE d.month = $1::date
        GROUP BY l.worker_id`,
      [monthDate]
    );
    if (error) throw error;
    const byWorker = {};
    for (const r of rows || []) byWorker[r.worker_id] = parseFloat(r.amount || 0);
    return byWorker;
  } catch (e) {
    console.warn('[salary] recorded loan deductions unavailable:', e?.message || String(e));
    return {};
  }
};

const parseSalaryCompensations = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

export const getSalaryCompensations = async () => {
  const stored = parseSalaryCompensations(await getSetting(SALARY_COMPENSATIONS_KEY));
  const all = [...stored];
  for (const fallback of Object.values(COMPENSATORY_WORKDAYS).flat()) {
    if (!all.some((entry) => entry.workDate === fallback.workDate && entry.holidayDate === fallback.holidayDate)) {
      all.push({ ...fallback, month: fallback.workDate.slice(0, 7) });
    }
  }
  return all.sort((a, b) => String(a.workDate).localeCompare(String(b.workDate)));
};

export const saveSalaryCompensations = async (compensations) => {
  if (!Array.isArray(compensations)) throw new Error('compensations must be an array');
  const normalized = compensations.map((entry) => ({
    month: String(entry.month || entry.workDate || '').slice(0, 7),
    workDate: String(entry.workDate || '').slice(0, 10),
    holidayDate: String(entry.holidayDate || '').slice(0, 10),
    name: String(entry.name || 'Compensatory holiday').trim(),
  }));
  for (const entry of normalized) {
    if (!/^\d{4}-\d{2}$/.test(entry.month) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.workDate) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.holidayDate)) {
      throw new Error('Each compensation needs a valid month, work date, and holiday date');
    }
    if (entry.workDate === entry.holidayDate) throw new Error('Work date and holiday date must be different');
    if (entry.month !== entry.workDate.slice(0, 7) || entry.month !== entry.holidayDate.slice(0, 7)) {
      throw new Error('The month must match both compensation dates');
    }
    if (new Date(`${entry.workDate}T00:00:00Z`).getUTCDay() !== 0) {
      throw new Error('The compensatory work date must be a Sunday');
    }
  }
  const unique = normalized.filter((entry, index, list) => list.findIndex((item) => item.workDate === entry.workDate && item.holidayDate === entry.holidayDate) === index);
  await upsertSetting(SALARY_COMPENSATIONS_KEY, JSON.stringify(unique));
  return getSalaryCompensations();
};

export const getSalariesByWorker = async (workerId) => {
  const { data, error } = await db
    .from('salary_history')
    .select('*')
    .eq('worker_id', workerId)
    .order('from_month', { ascending: false });
  if (error) throw error;
  return data;
};

export const getActiveSalaryByWorker = async (workerId) => {
  const { data, error } = await db
    .from('salary_history')
    .select('*')
    .eq('worker_id', workerId)
    .is('to_month', null)
    .order('from_month', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
};

// Batch form of getActiveSalaryByWorker: one query for a whole roster instead of
// N. Rows come back ordered by from_month desc, so the first row seen for a
// worker is the same one the per-worker .limit(1) would have returned (latest
// from_month among the open-ended ones). Returns a Map keyed by worker_id.
export const getActiveSalaryByWorkers = async (workerIds) => {
  const map = new Map();
  const ids = (workerIds || []).filter(Boolean);
  if (ids.length === 0) return map;
  const { data, error } = await db
    .from('salary_history')
    .select('worker_id, salary, from_month')
    .in('worker_id', ids)
    .is('to_month', null)
    .order('from_month', { ascending: false });
  if (error) throw error;
  for (const row of data || []) {
    if (!map.has(row.worker_id)) map.set(row.worker_id, row);
  }
  return map;
};

export const getSalaryById = async (id) => {
  const { data, error } = await db
    .from('salary_history')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const createSalary = async (salaryData) => {
  const { data, error } = await db
    .from('salary_history')
    .insert([salaryData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateSalary = async (id, updates) => {
  const { data, error } = await db
    .from('salary_history')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getAllWorkersSalarySummary = async () => {
  const { data: workers, error: wErr } = await db
    .from('workers')
    .select('id, name, email, department, created_at, is_test')
    .order('created_at', { ascending: false });
  if (wErr) throw wErr;

  const { data: salaries, error: sErr } = await db
    .from('salary_history')
    .select('*')
    .order('from_month', { ascending: false });
  if (sErr) throw sErr;

  const latest = {};
  for (const s of salaries) {
    if (s.to_month) continue;
    if (!latest[s.worker_id]) latest[s.worker_id] = s;
  }

  return workers.map(w => ({
    id: w.id,
    name: w.name,
    email: w.email,
    department: w.department,
    created_at: w.created_at,
    is_test: !!w.is_test,
    current_salary: latest[w.id]?.salary || null,
    current_salary_from: latest[w.id]?.from_month || null,
    current_salary_paid: latest[w.id]?.paid_at || null,
  }));
};

export const getPayrollData = async (month, extended = false) => {
  let year, monthIdx, startDate, endDate, daysInMonth;
  if (month) {
    const p = month.split('-');
    year = parseInt(p[0]);
    monthIdx = parseInt(p[1]) - 1;
    startDate = `${year}-${String(monthIdx + 1).padStart(2, '0')}-01`;
    daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    endDate = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  } else {
    const now = new Date();
    year = now.getFullYear();
    monthIdx = now.getMonth();
    startDate = `${year}-${String(monthIdx + 1).padStart(2, '0')}-01`;
    daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    endDate = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  }

  const selectFields = extended
    ? 'id, name, account_number, ifsc_code, account_holder_name, bank_name, department, created_at'
    : 'id, name, account_number, ifsc_code';
  const { data: workers, error: wErr } = await db
    .from('workers')
    .select(selectFields)
    .order('name');
  if (wErr) throw wErr;

  const { data: salaries, error: sErr } = await db
    .from('salary_history')
    .select('*')
    .order('from_month', { ascending: false });
  if (sErr) throw sErr;

  const latestSalary = {};
  for (const s of salaries) {
    if (s.to_month) continue;
    if (!latestSalary[s.worker_id]) latestSalary[s.worker_id] = s;
  }

  let targetsByWorker = {};
  let achievedByWorker = {};
  let akiByWorker = {};
  if (extended) {
    const ranges = await getAKISlabs();
    const { data: targets, error: tErr } = await db
      .from('incentive_targets')
      .select('worker_id, target_amount')
      .gte('month', startDate)
      .lte('month', endDate);
    if (!tErr) {
      for (const t of targets) {
        targetsByWorker[t.worker_id] = parseFloat(t.target_amount);
      }
    }

    const { data: achievements, error: aErr2 } = await db
      .from('daily_achievements')
      .select('worker_id, amount, date')
      .gte('date', startDate)
      .lte('date', endDate);
    if (!aErr2) {
      for (const a of achievements) {
        achievedByWorker[a.worker_id] = (achievedByWorker[a.worker_id] || 0) + parseFloat(a.amount || 0);
        const dayName = getDayName(a.date);
        akiByWorker[a.worker_id] = (akiByWorker[a.worker_id] || 0) + calculateAKI(parseFloat(a.amount || 0), dayName, ranges);
      }
    }
  }

  const { data: allAllocs, error: aErr } = await db
    .from('worker_ngo_allocations')
    .select('*, ngos(name)');
  if (aErr) throw aErr;

  const allocsByWorker = {};
  for (const a of allAllocs) {
    if (!allocsByWorker[a.worker_id]) allocsByWorker[a.worker_id] = [];
    allocsByWorker[a.worker_id].push(a);
  }

  const { data: attRecords, error: attErr } = await db
    .from('attendance')
    .select('worker_id, status, date')
    .gte('date', startDate)
    .lte('date', endDate);
  if (attErr) throw attErr;

  const attByWorker = {};
  for (const r of attRecords) {
    if (!attByWorker[r.worker_id]) attByWorker[r.worker_id] = [];
    attByWorker[r.worker_id].push(r);
  }

  // Fetch active loan deductions
  const { data: activeLoans, error: loanErr } = await db
    .from('worker_loans')
    .select('worker_id, monthly_deduction, remaining_amount, type, start_month, end_month')
    .in('status', LIVE_LOAN_STATUSES)
    .gt('remaining_amount', 0)
    .lte('start_month', endDate)
    .or(`end_month.is.null,end_month.gte.${startDate}`);
  const loanByWorker = {};
  if (!loanErr && activeLoans) {
    for (const l of activeLoans) {
      const ded = parseFloat(l.monthly_deduction || 0);
      if (ded > 0) {
        if (!loanByWorker[l.worker_id]) loanByWorker[l.worker_id] = [];
        loanByWorker[l.worker_id].push(l);
      }
    }
  }

  // What was actually recovered this month, as recorded by the settlement run.
  //
  // Deriving the figure from monthly_deduction on live loans alone silently drops
  // the final instalment of any loan: the settlement that repays the last amount
  // also closes the loan, and a closed row is no longer 'active', so the month it
  // was actually recovered in stops showing a deduction. Prefer the recorded rows
  // where they exist and only project the live loans for workers whose month has
  // not been settled yet — that way an un-settled month still previews correctly
  // instead of dropping to zero.
  const recordedLoanDeductions = await getRecordedLoanDeductionsForMonth(startDate);

  const monthDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, monthIdx, d);
    monthDays.push({ date: d, dayName: dt.getDay() });
  }
  const allSundays = monthDays.filter(d => d.dayName === 0).length;

  const rows = [];
  for (const w of workers) {
    const sal = latestSalary[w.id];
    const salary = sal ? parseFloat(sal.salary) : 0;
    if (salary <= 0) continue;

    const perDay = salary / daysInMonth;
    const workerAtt = attByWorker[w.id] || [];
    const absentCount = workerAtt.filter(r => r.status === 'absent').length;
    const presentCount = workerAtt.filter(r => r.status === 'present').length;
    const totalDue = Math.round(salary - perDay * absentCount);

    let monthlyIncentive = 0;
    let akiPayout = 0;
    if (extended) {
      const target = targetsByWorker[w.id] || 0;
      const achieved = achievedByWorker[w.id] || 0;
      const totalAKI = akiByWorker[w.id] || 0;
      if (target > 0 && achieved >= target) {
        const overage = achieved - target;
        monthlyIncentive = Math.round(overage * 0.1);
        const monthsEmp = w.created_at ? getMonthsEmployed(w.created_at, new Date(year, monthIdx + 1, 0)) : 99;
        akiPayout = monthsEmp <= 3 ? Math.round(totalAKI) : Math.round(totalAKI / 2);
      }
    }

    // Loan/advance deduction. All live loans are summed and a non-recurring
    // instalment is capped to the outstanding balance, via the same helper the
    // settlement and the Loans payroll check use.
    const loanDeduction = recordedLoanDeductions[w.id] !== undefined
      ? recordedLoanDeductions[w.id]
      : projectedLoanDeduction(loanByWorker[w.id]);
    const netDue = totalDue - Math.round(loanDeduction);

    const workerAllocs = allocsByWorker[w.id] || [];
    if (workerAllocs.length === 0) {
      const row = {
        ngo_name: 'Unallocated',
        name: w.name,
        account_number: w.account_number || '',
        ifsc_code: w.ifsc_code || '',
        total_due: netDue,
      };
      if (extended) {
        row.account_holder_name = w.account_holder_name || '';
        row.bank_name = w.bank_name || '';
        row.salary = salary;
        row.per_day = Math.round(perDay);
        row.days_in_month = daysInMonth;
        row.present_days = presentCount;
        row.absent_days = absentCount;
        row.sundays = allSundays;
        row.department = w.department || '';
        row.date_of_joining = w.created_at || '';
        row.target = Math.round(targetsByWorker[w.id] || 0);
        row.achieved = Math.round(achievedByWorker[w.id] || 0);
        row.monthly_incentive = monthlyIncentive;
        row.aki_payout = akiPayout;
        row.loan_deduction = Math.round(loanDeduction);
      }
      rows.push(row);
    } else {
      for (const a of workerAllocs) {
        const portion = parseFloat(a.salary_portion);
        const portionDue = Math.round(netDue * (portion / salary));
        const portionPerDay = Math.round(portion / daysInMonth);
        const row = {
          ngo_name: a.ngos?.name || 'Unknown',
          name: w.name,
          account_number: w.account_number || '',
          ifsc_code: w.ifsc_code || '',
          total_due: portionDue,
        };
        if (extended) {
          row.account_holder_name = w.account_holder_name || '';
          row.bank_name = w.bank_name || '';
          row.salary = Math.round(portion);
          row.per_day = portionPerDay;
          row.days_in_month = daysInMonth;
          row.present_days = presentCount;
          row.absent_days = absentCount;
          row.sundays = allSundays;
          row.department = w.department || '';
          row.date_of_joining = w.created_at || '';
          row.target = Math.round(targetsByWorker[w.id] || 0);
          row.achieved = Math.round(achievedByWorker[w.id] || 0);
          row.monthly_incentive = monthlyIncentive;
          row.aki_payout = akiPayout;
          row.loan_deduction = Math.round(loanDeduction);
        }
        rows.push(row);
      }
    }
  }

  rows.sort((a, b) => a.ngo_name.localeCompare(b.ngo_name) || a.name.localeCompare(b.name));
  return { month: startDate, rows };
};

export const deleteSalary = async (id) => {
  const { error } = await db
    .from('salary_history')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Salary record deleted' };
};

export const getPresentDaysByMonth = async (month) => {
  const p = String(month || '').split('-');
  if (p.length !== 2) throw new Error('month must be YYYY-MM');
  const year = parseInt(p[0], 10);
  const monthIdx = parseInt(p[1], 10) - 1;
  if (!year || monthIdx < 0 || monthIdx > 11) throw new Error('month must be YYYY-MM');
  const pad = n => String(n).padStart(2, '0');
  const monthStr = `${year}-${pad(monthIdx + 1)}`;
  const startDate = `${monthStr}-01`;
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const endDate = `${monthStr}-${pad(daysInMonth)}`;

  const { data: workers, error: wErr } = await db
    .from('workers')
    .select('id, name, created_at');
  if (wErr) throw wErr;

  // Per-person late grace (tolerant: empty map if column/migration missing).
  let graceByWorker = {};
  try {
    const { data: graceRows, error: gErr } = await db
      .from('workers')
      .select('id, late_grace_minutes');
    if (!gErr && graceRows) {
      for (const g of graceRows) {
        if (g.late_grace_minutes != null && g.late_grace_minutes !== '') {
          graceByWorker[g.id] = g.late_grace_minutes;
        }
      }
    }
  } catch (_) { graceByWorker = {}; }

  const { data: attRecords, error: aErr } = await db
    .from('attendance')
    .select('worker_id, status, date, late_minutes')
    .gte('date', startDate)
    .lte('date', endDate);
  if (aErr) throw aErr;

  const { data: holidays, error: hErr } = await db
    .from('holidays')
    .select('date')
    .gte('date', startDate)
    .lte('date', endDate);
  const holidayDates = (hErr || !holidays) ? [] : holidays.map(h => h.date);

  const { data: collLogs, error: collErr } = await db
    .from('fro_donor_logs')
    .select('amount_collected, fro_assignments!inner(fro_worker_id)')
    .or(
      `and(action.eq.donation,created_at.gte.${startDate},created_at.lte.${endDate}),` +
      `and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified,verified_at.gte.${startDate},verified_at.lte.${endDate}),` +
      `and(disposition_detail.eq.done,action.eq.disposition,created_at.gte.${startDate},created_at.lte.${endDate})`
    );
  const collectionByWorker = {};
  if (!collErr) {
    for (const d of collLogs || []) {
      const wid = d.fro_assignments && d.fro_assignments.fro_worker_id;
      if (!wid) continue;
      collectionByWorker[wid] = (collectionByWorker[wid] || 0) + parseFloat(d.amount_collected || 0);
    }
  }

  const counts = {};
  const attByWorker = {};
  for (const r of attRecords) {
    if (!attByWorker[r.worker_id]) attByWorker[r.worker_id] = [];
    attByWorker[r.worker_id].push(r);
    if (!counts[r.worker_id]) counts[r.worker_id] = { present: 0, late: 0, half: 0, absent: 0, leave: 0 };
    if (counts[r.worker_id][r.status] !== undefined) counts[r.worker_id][r.status]++;
    else counts[r.worker_id][r.status] = 1;
  }

  const rows = workers.map(w => {
    const c = counts[w.id] || { present: 0, late: 0, half: 0, absent: 0, leave: 0 };
    const calc = computePaidDays({
      year,
      month: monthIdx,
      daysInMonth,
      records: attByWorker[w.id] || [],
      createdAt: w.created_at || '',
      holidayDates,
      lateGraceMinutes: graceByWorker[w.id] ?? null,
    });
    return {
      worker_id: w.id,
      name: w.name,
      date_of_joining: w.created_at || '',
      present: c.present,
      late: c.late,
      half: c.half,
      absent: c.absent,
      leave: c.leave,
      paid_days: calc.paidDays,
      late_deduction_days: calc.lateDeductionDays,
      late_grace_minutes: calc.lateGraceMinutes,
      late_thresholds: calc.lateThresholds,
      joining_deduction: calc.joiningDeduction,
      available_days: calc.available,
      absent_count: calc.absentDatesAfterJoin.length,
      half_days: calc.halfDayCount,
      leave_count: calc.leaveCount,
      sunday_count: calc.sundayStats.totalSundays,
      attended_sundays: calc.sundayStats.attendedSundays,
      unpaid_sundays: calc.sundayStats.unpaidSundays.length,
      clubbed_sundays: calc.clubbedSundays,
      extra_sundays: calc.extraSundayCount,
      free_sundays: calc.freeSundays,
      sunday_reasons: calc.sundayReasons.map(r => ({ date: r.date, reason: r.reason })),
      deducted_sundays: calc.sundayStats.cancelledSundays.length + calc.sundayStats.unpaidSundays.length,
      total_late_minutes: calc.totalLateMinutes,
      sunday_add: calc.sundayAdd,
      deducted_days: calc.deductedCount,
      worked_days: calc.totalDueDays,
      collection: collectionByWorker[w.id] || 0,
    };
  });

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { month: startDate, days_in_month: daysInMonth, total_workers: rows.length, rows };
};

export const getPagarExportData = async (month) => {
  const p = String(month || '').split('-');
  if (p.length !== 2) throw new Error('month must be YYYY-MM');
  const year = parseInt(p[0], 10);
  const monthIdx = parseInt(p[1], 10) - 1;
  if (!year || monthIdx < 0 || monthIdx > 11) throw new Error('month must be YYYY-MM');
  const pad = n => String(n).padStart(2, '0');
  const monthStr = `${year}-${pad(monthIdx + 1)}`;
  const startDate = `${monthStr}-01`;
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const endDate = `${monthStr}-${pad(daysInMonth)}`;

  // Determine viewingToday: for current month use today's IST day; for past months use full month
  const ist = getISTToday();
  const isCurrentMonth = (year === ist.year && monthIdx === ist.month);
  const viewingToday = isCurrentMonth ? ist.day : daysInMonth + 1;

  const akiranges = await getAKISlabs();

  // 1. Workers with basic info
  const { data: workers, error: wErr } = await db
    .from('workers')
    .select('id, name, department, employment_status, account_holder_name, account_number, bank_name, ifsc_code, created_at, father_husband_name, ngo_id');
  if (wErr) throw wErr;

  // Per-person late grace (tolerant: empty map if column/migration missing).
  let graceByWorker = {};
  try {
    const { data: graceRows, error: gErr } = await db
      .from('workers')
      .select('id, late_grace_minutes');
    if (!gErr && graceRows) {
      for (const g of graceRows) {
        if (g.late_grace_minutes != null && g.late_grace_minutes !== '') {
          graceByWorker[g.id] = g.late_grace_minutes;
        }
      }
    }
  } catch (_) { graceByWorker = {}; }
  for (const w of workers) {
    if (w.late_grace_minutes == null && graceByWorker[w.id] != null) {
      w.late_grace_minutes = graceByWorker[w.id];
    }
  }

  // 2. Latest salary per worker
  const { data: salaries, error: sErr } = await db
    .from('salary_history')
    .select('*')
    .order('from_month', { ascending: false });
  if (sErr) throw sErr;
  const latestSalary = {};
  for (const s of salaries) {
    if (s.to_month) continue;
    if (!latestSalary[s.worker_id]) latestSalary[s.worker_id] = s;
  }
  // Only workers with a current salary get a row in this file; receipts credited
  // to anyone else must fall into the Unattributed bucket so columns still tally
  // exactly with the Collection Report cards.
  const salariedWorkerIds = new Set();
  for (const w of workers) {
    const sl = latestSalary[w.id];
    if (sl && parseFloat(sl.salary) > 0) salariedWorkerIds.add(w.id);
  }

  // 3. Targets for month — manual fro_monthly_targets (latest per worker) wins over auto incentive_targets
  // fro_monthly_targets stores month as first-of-month (YYYY-MM-01), matching our startDate
  // Exclude target_amount = 0 (phantom rows created by achieved_target/incentive upserts)
  const { data: manualTargets, error: mtErr } = await db
    .from('fro_monthly_targets')
    .select('fro_worker_id, target_amount, created_at')
    .eq('month', startDate)
    .gt('target_amount', 0)
    .order('created_at', { ascending: false });
  if (mtErr) throw mtErr;
  
  // Take latest created_at row per worker (mirrors getTargetByWorker in froTargetModel.js)
  const manualTargetByWorker = {};
  for (const t of manualTargets || []) {
    if (!manualTargetByWorker[t.fro_worker_id]) {
      manualTargetByWorker[t.fro_worker_id] = parseFloat(t.target_amount);
    }
  }

  // Fallback: auto-generated incentive_targets
  const { data: autoTargets, error: atErr } = await db
    .from('incentive_targets')
    .select('worker_id, target_amount, month')
    .gte('month', startDate)
    .lte('month', endDate)
    .gt('target_amount', 0)
    .order('month', { ascending: false });
  if (atErr) throw atErr;
  
  const targetByWorker = { ...manualTargetByWorker };
  for (const t of autoTargets) {
    if (!targetByWorker[t.worker_id]) {
      targetByWorker[t.worker_id] = parseFloat(t.target_amount);
    }
  }

  // 4. Attendance data (reuse getPresentDaysByMonth logic)
  const { data: attRecords, error: aErr } = await db
    .from('attendance')
    .select('worker_id, status, date, late_minutes')
    .gte('date', startDate)
    .lte('date', endDate);
  if (aErr) throw aErr;

  const { data: holidays, error: hErr } = await db
    .from('holidays')
    .select('date')
    .gte('date', startDate)
    .lte('date', endDate);
  const holidayDates = (hErr || !holidays) ? [] : holidays.map(h => h.date);
  const salaryCompensations = (await getSalaryCompensations()).filter((entry) => entry.month === monthStr);

  const attByWorker = {};
  for (const r of attRecords) {
    if (!attByWorker[r.worker_id]) attByWorker[r.worker_id] = [];
    attByWorker[r.worker_id].push(r);
  }

  // 4b. Idle seconds per FRO for the month, summed from the daily snapshots.
  // Powers the HR salary sheet's "Idle Time (Hrs)" column. Non-fatal: the table
  // may be absent until migration 126 is applied.
  const idleSecondsByWorker = {};
  try {
    const { data: idleRows } = await db
      .from('fro_daily_stats')
      .select('worker_id, idle_seconds')
      .gte('stat_date', startDate)
      .lte('stat_date', endDate);
    for (const r of idleRows || []) {
      idleSecondsByWorker[r.worker_id] = (idleSecondsByWorker[r.worker_id] || 0) + (Number(r.idle_seconds) || 0);
    }
  } catch (e) {
    // Non-fatal.
  }

  // 5. Station assignments
  const { data: stations, error: stErr } = await db
    .from('fro_station_assignments')
    .select('fro_worker_id, station');
  if (stErr) throw stErr;
  const stationsByWorker = {};
  for (const s of stations || []) {
    if (!stationsByWorker[s.fro_worker_id]) stationsByWorker[s.fro_worker_id] = [];
    stationsByWorker[s.fro_worker_id].push(s.station);
  }

  // 6. Collections from RECEIPTS (matches the Accounts Agent-wise report).
  // Achieved/daily amounts are attributed by receipt.agent_name -> FRO worker,
  // and split by the receipt's project into BSCT/AFLF/MANN. Receipts whose
  // agent_name is PG/Library/Suspense are tracked as their own category buckets
  // and emitted as trailing rows in the salary file.
  const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Resolve receipt.project_id (slug / ngo uuid / ngo name) -> project slug,
  // mirroring resolveNgo in getAgentTeamCollections.
  const { data: allNgos, error: naErr } = await db.from('ngos').select('id, name, code').eq('is_active', true);
  if (naErr) throw naErr;
  const ngoNameById = {};
  for (const n of allNgos || []) {
    ngoNameById[String(n.id).toLowerCase()] = n.name || '';
  }
  const uuidToSlug = {};
  const nameNormToSlug = {};
  for (const n of allNgos || []) {
    const slug = String((n.code || n.name || '').trim()).toLowerCase();
    if (!slug) continue;
    uuidToSlug[String(n.id).toLowerCase()] = slug;
    const nn = normKey(n.name);
    if (nn) nameNormToSlug[nn] = slug;
  }
  const resolveProject = (pid) => {
    if (!pid) return null;
    const low = String(pid).toLowerCase().trim();
    if (['bsct', 'aflf', 'mann', 'pg', 'library', 'suspense'].includes(low)) return low;
    if (uuidToSlug[low]) return uuidToSlug[low];
    const nn = normKey(pid);
    return nameNormToSlug[nn] || null;
  };
  const projectToNgo = { bsct: 'BSCT', aflf: 'AFLF', mann: 'MANN' };

  // FRO worker id by normalized name (active, non-test) - same attribution as
  // the Accounts report.
  const { data: froWorkers, error: frErr } = await db
    .from('workers')
    .select('id, name')
    .eq('department', 'FRO')
    .eq('employment_status', 'active')
    .eq('is_test', false);
  if (frErr) throw frErr;
  const workerByKey = {};
  for (const w of froWorkers || []) {
    const k = normKey(w.name);
    if (k && !workerByKey[k]) workerByKey[k] = w.id;
  }

  const { data: receiptRows, error: recErr } = await db
    .from('receipts')
    .select('project_id, amount, agent_name, receipt_date, receipt_no, donor_id, payment_id')
    .not('receipt_no', 'is', null)
    .gte('receipt_date', startDate)
    .lte('receipt_date', endDate);
  if (recErr) throw recErr;

  const collectionByWorker = {};
  const dailyByWorker = {};
  const NgoByWorker = {};
  const categoryByNgo = {
    pg: { BSCT: 0, AFLF: 0, MANN: 0, Other: 0, total: 0 },
    library: { BSCT: 0, AFLF: 0, MANN: 0, Other: 0, total: 0 },
    suspense: { BSCT: 0, AFLF: 0, MANN: 0, Other: 0, total: 0 },
    anjana_fro: { BSCT: 0, AFLF: 0, MANN: 0, Other: 0, total: 0 },
    priyank_shah: { BSCT: 0, AFLF: 0, MANN: 0, Other: 0, total: 0 },
  };
  const totalNgo = { BSCT: 0, AFLF: 0, MANN: 0 }; // all receipts per project (report cards)
  const seen = new Set();

  // Which receipts count as "Anjana FRO" by agent name (everything else that is
  // unmatched and named goes to the Priyank Shah bucket).
  const ANJANA_STOP = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'shri', 'shree', 'kumari', 'kumar', 'sir', 'ben']);
  const isAnjanaAgent = (name) => {
    const parts = normKey(String(name || '')).split(' ').filter((w) => w && !ANJANA_STOP.has(w));
    return (parts.length === 1 && parts[0] === 'anjana')
      || (parts.length === 2 && parts[0] === 'anjana' && parts[1] === 'vyas');
  };

  for (const r of receiptRows || []) {
    const amount = parseFloat(r.amount || 0);
    if (!(amount > 0)) continue;
    const date = String(r.receipt_date || '');
    const day = parseInt(date.slice(8, 10), 10);
    if (!day) continue;
    const dedupKey = `${r.receipt_no || ''}|${r.donor_id || ''}|${amount}|${date}|${r.payment_id || ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const proj = resolveProject(r.project_id);
    const rawAgent = String(r.agent_name || '').trim();
    const agentLower = rawAgent.toLowerCase();

    // Exact Collection-Report bucketing (accountsController.getReportData):
    //  1) Suspense agent (blank / 'na' / 'suspense') wins over ANY project -> Suspense card
    //  2) library/pg are AGENT buckets (agent_name = library/pg, project_id is still bsct) -> Library/PG cards
    //  3) otherwise the project must resolve to bsct/aflf/mann -> the NGO card pool
    const isSuspenseish = rawAgent === '' || agentLower === 'na' || agentLower === 'suspense';
    if (isSuspenseish || agentLower === 'library' || agentLower === 'pg') {
      // Suspense / Library / PG category receipts. Split by the receipt's own
      // project_id into the BSCT/AFLF/MANN columns (dynamic) so the salary file
      // rows reflect the report's project breakdown. project-less receipts stay
      // in Other (counted in the category total, but no NGO column).
      const catKey = isSuspenseish ? 'suspense' : agentLower;
      const cat = categoryByNgo[catKey];
      const ngoName = projectToNgo[proj];
      if (ngoName) cat[ngoName] = (cat[ngoName] || 0) + amount;
      else cat['Other'] = (cat['Other'] || 0) + amount;
      cat.total += amount;
      continue;
    }

    const ngoName = projectToNgo[proj];
    if (!ngoName) continue;
    totalNgo[ngoName] += amount;

    let wid = null;
    let canonical = rawAgent || '';
    if (rawAgent) {
      canonical = await normalizeAgentName(rawAgent);
      wid = workerByKey[normKey(canonical)] || null;
    }
    if (wid && salariedWorkerIds.has(wid)) {
      if (!collectionByWorker[wid]) collectionByWorker[wid] = 0;
      collectionByWorker[wid] += amount;

      if (!dailyByWorker[wid]) dailyByWorker[wid] = {};
      dailyByWorker[wid][day] = (dailyByWorker[wid][day] || 0) + amount;

      if (!NgoByWorker[wid]) NgoByWorker[wid] = { BSCT: 0, AFLF: 0, MANN: 0, Other: 0 };
      NgoByWorker[wid][ngoName] = (NgoByWorker[wid][ngoName] || 0) + amount;
    } else {
      // Named (non-suspense) receipt that did not land on an active salaried FRO
      // row. Anjana-named agents (Anjana / Anjana Vyas) go to the Anjana FRO
      // bucket; every other unmatched named receipt (Priyank Sir, deleted-account
      // FROs, any ex-FRO) is claimed under Priyank Shah. Both keep their
      // NGO-column split so the file still tallies with the report cards.
      const catKey = isAnjanaAgent(canonical || rawAgent) ? 'anjana_fro' : 'priyank_shah';
      const cat = categoryByNgo[catKey];
      cat[ngoName] = (cat[ngoName] || 0) + amount;
      cat.total += amount;
    }
  }

  // Merge manual daily_achievements (manual wins for that day's total)
  const { data: manualAch, error: maErr } = await db
    .from('daily_achievements')
    .select('worker_id, amount, date')
    .gte('date', startDate)
    .lte('date', endDate);
  if (!maErr && manualAch) {
    for (const m of manualAch) {
      const wid = m.worker_id;
      const day = parseInt(m.date.slice(8, 10), 10);
      const amount = parseFloat(m.amount || 0);
      if (!day || amount <= 0) continue;
      if (!dailyByWorker[wid]) dailyByWorker[wid] = {};
      dailyByWorker[wid][day] = amount; // manual wins
    }
  }

  // 7. Active loans for advance deduction
  // Must carry the same period filter as the payslip pick above (see
  // getActiveLoansByWorker). Filtering on status alone let a loan whose term had
  // already ended keep deducting from salary forever: expireOverdueLoans retires
  // those rows, but the window between a term ending and the next settlement run
  // is still enough to deduct an expired loan out of a live salary month.
  const { data: loans, error: lnErr } = await db
    .from('worker_loans')
    .select('worker_id, monthly_deduction, remaining_amount, recurring')
    .in('status', LIVE_LOAN_STATUSES)
    .gt('remaining_amount', 0)
    .lte('start_month', endDate)
    .or(`end_month.is.null,end_month.gte.${startDate}`);
  if (lnErr) throw lnErr;
  // All of a worker's live loans are summed and a non-recurring instalment is
  // capped to the outstanding balance. This used to be `loanByWorker[id] = ded`,
  // which silently kept only the last loan, so a worker holding a recurring
  // deposit plus a one-time advance lost one of the two instalments.
  const loanByWorker = {};
  for (const l of loans || []) {
    const monthly = parseFloat(l.monthly_deduction || 0);
    if (!(monthly > 0)) continue;
    const remaining = parseFloat(l.remaining_amount || 0);
    const ded = l.recurring ? monthly : Math.min(monthly, remaining);
    if (ded > 0) loanByWorker[l.worker_id] = (loanByWorker[l.worker_id] || 0) + ded;
  }

  // Prefer the deductions actually recorded for this month over the projection, for
  // the same reason as the payslip: the month a loan's final instalment was
  // recovered is also the month it gets closed, so a closed loan is invisible to
  // the projection above and its last instalment would be lost from the export.
  const recordedLoanDeductions = await getRecordedLoanDeductionsForMonth(startDate);

  // 7b. Per-month salary holds (Hold/Released). Absence of a row = Released.
  const { data: holds, error: holdErr } = await db
    .from('salary_holds')
    .select('worker_id, reason')
    .eq('salary_month', monthStr);
  if (holdErr) throw holdErr;
  const holdByWorker = {};
  for (const h of holds || []) holdByWorker[h.worker_id] = h.reason || '';

  // 8. Compute per worker
  const rows = [];
  for (const w of workers) {
    const sal = latestSalary[w.id];
    const salary = sal ? parseFloat(sal.salary) : 0;
    if (salary <= 0) continue; // skip workers without salary

    const workerAtt = attByWorker[w.id] || [];
    const attResult = computePaidDays({
      year,
      month: monthIdx,
      daysInMonth,
      records: workerAtt,
      createdAt: w.created_at || '',
      holidayDates,
      viewingToday,
      includeHolidayPay: true,
      compensatoryWorkdays: salaryCompensations,
      lateGraceMinutes: w.late_grace_minutes ?? null,
    });

    const target = targetByWorker[w.id] || 0;
    const achieved = collectionByWorker[w.id] || 0;
    const perDay = salary / daysInMonth;
    const netPresentDays = attResult.totalDueDays;
    const grossPresentDays = attResult.paidDays;
    const lateDeductionDays = attResult.lateDeductionDays;
    const sundayDeductionDays = attResult.sundayDeductionDays;
    const trainingDeductionDays = attResult.joiningDeduction;

    const monthlyIncentive = (target > 0 && achieved >= target)
      ? Math.round((achieved - target) * 0.1)
      : 0;

    const monthsEmployed = getMonthsEmployed(w.created_at, new Date(year, monthIdx + 1, 0));
    const isNewJoiner = monthsEmployed !== null && monthsEmployed <= 3;

    let totalAKI = 0;
    const daily = dailyByWorker[w.id] || {};
    for (let d = 1; d <= daysInMonth; d++) {
      const amount = daily[d] || 0;
      if (amount > 0) {
        const dayName = getDayName(`${year}-${pad(monthIdx + 1)}-${pad(d)}`);
        totalAKI += calculateAKI(amount, dayName, akiranges);
      }
    }
    const akiPayout = (target > 0 && achieved >= target)
      ? (isNewJoiner ? Math.round(totalAKI) : Math.round(totalAKI / 2))
      : 0;

    const advanceDeduction = recordedLoanDeductions[w.id] !== undefined
      ? recordedLoanDeductions[w.id]
      : (loanByWorker[w.id] || 0);

    const monthSalary = Math.round(perDay * netPresentDays);
    const grossPayable = monthSalary + monthlyIncentive + akiPayout;
    const netPayable = Math.max(0, grossPayable - advanceDeduction);

    const stationStr = (stationsByWorker[w.id] || []).join(' / ');

    const ngo = NgoByWorker[w.id] || { BSCT: 0, AFLF: 0, MANN: 0, Other: 0 };
    const totalAchieved = achieved; // sum of all NGOs

    rows.push({
      id: w.id,
      name: w.name,
      ngo: ngoNameById[String(w.ngo_id).toLowerCase()] || '',
      status: (w.employment_status || '').toUpperCase(),
      department: w.department || '',
      salary_status: holdByWorker[w.id] !== undefined ? 'held' : 'released',
      hold_reason: holdByWorker[w.id] || '',
      account_holder_name: w.account_holder_name || '',
      account_holder_relation: w.father_husband_name || '', // blank or father name
      bank_name: w.bank_name || '',
      account_number: w.account_number || '',
      ifsc_code: w.ifsc_code || '',
      station: stationStr,
      doj: w.created_at ? String(w.created_at).slice(0, 10) : '',
      salary,
      target,
      achieved: totalAchieved,
      achieved_bsct: ngo.BSCT || 0,
      achieved_aflf: ngo.AFLF || 0,
      achieved_mann: ngo.MANN || 0,
      gross_present_days: grossPresentDays,
      present_days: attResult.presentDays,
      holiday_paid_days: attResult.holidayPaidDays,
      compensatory_work_days: attResult.compensatoryWorkDays,
      compensated_holiday_days: attResult.compensatedHolidayDays,
      required_sunday_worked_days: attResult.requiredSundayWorkedDays,
      absent_days: attResult.absentDatesAfterJoin.length,
      half_days: attResult.halfDayCount * 0.5,
      late_deduction_days: lateDeductionDays,
      late_grace_minutes: attResult.lateGraceMinutes,
      late_thresholds: attResult.lateThresholds,
      total_late_minutes: attResult.totalLateMinutes,
      sunday_deduction_days: sundayDeductionDays,
      training_deduction_days: trainingDeductionDays,
      net_present_days: netPresentDays,
      month_salary: monthSalary,
      monthly_incentive: monthlyIncentive,
      total_aki: Math.round(totalAKI),
      aki_payout: akiPayout,
      gross_payable: grossPayable,
      advance_deduction: advanceDeduction,
      net_payable: netPayable,
      idle_seconds: idleSecondsByWorker[w.id] || 0,
      daily: daily, // { day: amount }
      days_in_month: daysInMonth,
      start_date: startDate,
    });
  }

  // Category collection rows (Pg / Library / Suspense) - receipts whose
  // agent_name is the category label, shown as trailing rows in the salary file.
  const categoryLabels = { pg: 'Pg', library: 'Library', suspense: 'Suspense', anjana_fro: 'Anjana FRO', priyank_shah: 'Priyank Shah' };
  const makeCategoryRow = (label, cat, status, department) => rows.push({
    id: null,
    name: label,
    ngo: '',
    status,
    department,
    account_holder_name: '',
    account_holder_relation: '',
    bank_name: '',
    account_number: '',
    station: '',
    doj: '',
    salary: 0,
    target: 0,
    achieved: cat.total,
    achieved_bsct: cat.BSCT || 0,
    achieved_aflf: cat.AFLF || 0,
    achieved_mann: cat.MANN || 0,
    gross_present_days: 0,
    present_days: 0,
    holiday_paid_days: 0,
    compensatory_work_days: 0,
    compensated_holiday_days: 0,
    required_sunday_worked_days: 0,
    late_deduction_days: 0,
    sunday_deduction_days: 0,
    training_deduction_days: 0,
    absent_days: 0,
    half_days: 0,
    net_present_days: 0,
    month_salary: 0,
    monthly_incentive: 0,
    total_aki: 0,
    aki_payout: 0,
    gross_payable: 0,
    advance_deduction: 0,
    net_payable: 0,
    idle_seconds: 0,
    daily: {},
    days_in_month: daysInMonth,
    start_date: startDate,
  });

  // Pg / Library / Suspense stay trailing CATEGORY rows.
  for (const c of ['pg', 'library', 'suspense']) {
    makeCategoryRow(categoryLabels[c], categoryByNgo[c], 'CATEGORY', '');
  }

  // Anjana FRO / Priyank Shah are treated as ACTIVE FRO rows (so they live in
  // the Active section and feed the Active FRO + Grand totals), with zero
  // salary / target / present-days since they are pure collection buckets.
  for (const c of ['anjana_fro', 'priyank_shah']) {
    makeCategoryRow(categoryLabels[c], categoryByNgo[c], 'ACTIVE', 'FRO');
  }

  // Sort: Active first (by dept), then Absconded (by dept), then other
  // non-active (Offboarded/Inactive/etc), then CATEGORY rows (Pg/Library/Suspense).
  const deptOrder = { 'FRO': 0, 'Digital': 1, 'Admin': 2, 'NGO Admin': 3, 'Event Manager': 4, 'Housekeeping': 5, 'HR': 6, 'HR-Recruiter': 7 };
  const statusGroup = (s) => {
    if (s === 'ACTIVE') return 0;
    if (s === 'ABSCONDED' || s === 'ABSCOND') return 1;
    if (s === 'CATEGORY') return 3;
    return 2;
  };
  rows.sort((a, b) => {
    const aG = statusGroup(a.status);
    const bG = statusGroup(b.status);
    if (aG !== bG) return aG - bG;
    const aDept = deptOrder[a.department] ?? 99;
    const bDept = deptOrder[b.department] ?? 99;
    if (aDept !== bDept) return aDept - bDept;
    return a.name.localeCompare(b.name);
  });

  return { month: monthStr, days_in_month: daysInMonth, rows };
};

// Mirrors normalizeName() in the salary frontend so Excel names ("Nazreen
// Zahur Baig") resolve to DB workers ("Nazreen Baig").
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+-\s+.*$/g, '')
    .replace(/\bleft\b/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveWorkerByName(workers, name) {
  const n = normalizeName(name);
  if (!n) return undefined;
  let match = workers.find(w => normalizeName(w.name) === n);
  if (match) return match;
  const parts = n.split(' ').filter(Boolean);
  const normKeys = workers.map(w => normalizeName(w.name));
  if (parts.length >= 2) {
    const firstLast = parts[0] + ' ' + parts[parts.length - 1];
    match = workers.find(w => normalizeName(w.name) === firstLast);
    if (match) return match;
    for (let i = 0; i < workers.length; i++) {
      const kp = normKeys[i].split(' ').filter(Boolean);
      if (kp.length >= 2 && kp[0] + ' ' + kp[kp.length - 1] === firstLast) return workers[i];
    }
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const byFirst = workers.filter((_, i) => normKeys[i].split(' ')[0] === first);
  if (byFirst.length === 1) return byFirst[0];
  const byLast = workers.filter((_, i) => {
    const kp = normKeys[i].split(' ').filter(Boolean);
    return kp[kp.length - 1] === last;
  });
  if (byLast.length === 1) return byLast[0];
  const tokSet = new Set(parts);
  const excelInDb = workers.filter((_, i) => {
    const kp = normKeys[i].split(' ').filter(Boolean);
    return kp.length > 1 && kp.every(t => tokSet.has(t));
  });
  if (excelInDb.length === 1) return excelInDb[0];
  const dbInExcel = workers.filter((_, i) => {
    const kp = normKeys[i].split(' ').filter(Boolean);
    return kp.length <= parts.length && parts.every(t => kp.includes(t));
  });
  if (dbInExcel.length === 1) return dbInExcel[0];
  return undefined;
}

// Daily attendance grid for one worker for a month — day-by-day status
// (present/late/half-day/absent/leave/sunday) with punch in/out times.
export const getWorkerAttendanceByName = async (month, name) => {
  const p = String(month || '').split('-');
  if (p.length !== 2) throw new Error('month must be YYYY-MM');
  const year = parseInt(p[0], 10);
  const monthIdx = parseInt(p[1], 10) - 1;
  if (!year || monthIdx < 0 || monthIdx > 11) throw new Error('month must be YYYY-MM');
  const pad = n => String(n).padStart(2, '0');
  const monthStr = `${year}-${pad(monthIdx + 1)}`;
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const startDate = `${monthStr}-01`;
  const endDate = `${monthStr}-${pad(daysInMonth)}`;

  const { data: workers, error: wErr } = await db
    .from('workers')
    .select('id, name, created_at');
  if (wErr) throw wErr;

  const worker = resolveWorkerByName(workers, name);
  if (!worker) return { worker: null, days_in_month: daysInMonth, stats: null, rows: [] };

  const { data: records, error: aErr } = await db
    .from('attendance')
    .select('*')
    .eq('worker_id', worker.id)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (aErr) throw aErr;

  const { data: leaves, error: lErr } = await db
    .from('leaves')
    .select('leave_date, start_date, end_date')
    .eq('worker_id', worker.id);
  const leaveDates = new Set();
  if (!lErr && leaves) {
    for (const l of leaves) {
      const start = l.leave_date || l.start_date;
      const end = l.leave_date || l.end_date;
      if (!start) continue;
      const s = new Date(start + 'T00:00:00Z');
      const e = new Date((end || start) + 'T00:00:00Z');
      if (isNaN(s.getTime()) || isNaN(e.getTime())) continue;
      for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = d.toISOString().slice(0, 10);
        if (ds >= startDate && ds <= endDate) leaveDates.add(ds);
      }
    }
  }

  const recByDate = {};
  for (const r of records) recByDate[r.date] = r;

  const { data: holidays, error: hErr } = await db
    .from('holidays')
    .select('date')
    .gte('date', startDate)
    .lte('date', endDate);
  const holidaySet = new Set((hErr || !holidays ? [] : holidays).map(h => String(h.date).slice(0, 10)));

  // Mirrors computePaidDays(): only days up to "today" (IST) count as absent;
  // holidays, Sundays and days before joining are not absences.
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const viewDay = (istNow.getUTCFullYear() === year && istNow.getUTCMonth() === monthIdx)
    ? istNow.getUTCDate()
    : daysInMonth + 1;

  const joinDate = worker.created_at ? new Date(worker.created_at) : null;
  const joinedThisMonth = joinDate && !isNaN(joinDate.getTime())
    ? joinDate.getFullYear() === year && joinDate.getMonth() === monthIdx
    : false;
  const beforeJoinSet = joinedThisMonth
    ? new Set(Array.from({ length: joinDate.getUTCDate() - 1 }, (_, i) => `${monthStr}-${pad(i + 1)}`))
    : new Set();

  const fmtTime = (t) => {
    if (!t) return null;
    const d = new Date(t);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  };

  const rows = [];
  const stats = { present: 0, late: 0, half: 0, absent: 0, leave: 0, sunday: 0, holiday: 0 };
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${monthStr}-${pad(d)}`;
    const dow = new Date(Date.UTC(year, monthIdx, d)).getUTCDay();
    const rec = recByDate[dateStr];
    let status;
    if (rec) {
      status = rec.status;
    } else if (leaveDates.has(dateStr)) {
      status = 'leave';
    } else if (beforeJoinSet.has(dateStr) || d > viewDay) {
      status = 'future';
    } else if (dow !== 0) {
      status = holidaySet.has(dateStr) ? 'holiday' : 'absent';
    } else {
      status = 'sunday';
    }
    if (stats[status] !== undefined) stats[status]++;
    const pi = rec && rec.punch_in_time ? new Date(rec.punch_in_time).getTime() : null;
    const po = rec && rec.punch_out_time ? new Date(rec.punch_out_time).getTime() : null;
    let hoursWorked = null;
    if (pi && po && !isNaN(pi) && !isNaN(po)) {
      const mins = Math.max(0, Math.round((po - pi) / 60000));
      hoursWorked = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    }
    rows.push({
      date: dateStr,
      day: dow,
      status,
      id: rec ? rec.id : null,
      late_minutes: rec ? (rec.late_minutes || 0) : 0,
      punch_in: fmtTime(rec && rec.punch_in_time),
      punch_out: fmtTime(rec && rec.punch_out_time),
      hours_worked: hoursWorked,
    });
  }
  return { worker: { id: worker.id, name: worker.name, date_of_joining: worker.created_at || '' }, days_in_month: daysInMonth, stats, rows };
};
