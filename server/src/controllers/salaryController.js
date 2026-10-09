import {
  getSalariesByWorker,
  getActiveSalaryByWorker,
  getSalaryById,
  createSalary,
  updateSalary,
  deleteSalary,
  getAllWorkersSalarySummary,
  getPayrollData,
  getPresentDaysByMonth,
  getWorkerAttendanceByName,
  getPagarExportData,
  getSalaryCompensations,
  saveSalaryCompensations,
} from '../models/salaryModel.js';
import db from '../config/db.js';
import { getMonthlyAttendance, upsertAttendanceStatus } from '../models/attendanceModel.js';
import { getWorkerById } from '../models/workerModel.js';
import { getAllocationsByWorker } from '../models/workerNgoAllocationModel.js';
import { getTarget, upsertTarget } from '../models/incentiveModel.js';
import { getMonthsEmployed } from '../utils/incentive.js';
import { getMergedDailyAmounts } from '../utils/dailyAchievementAggregator.js';
import { computeSundayStats, computePaidDays } from '../utils/salaryDays.js';
import { getActiveLoansByWorker } from '../models/loanModel.js';
import { getHolidaysInRange } from '../models/holidayModel.js';
import { getSetting, upsertSetting } from '../models/settingsModel.js';
import { getWorkerAttendanceReport } from '../models/attendanceReportModel.js';
import { renderAttendanceReportDocx, reportFileName, DOCX_MIME } from '../services/attendanceReportDocx.js';

const salaryCodeKey = (userId) => `accounts_access_code_${userId}`;
const codeToStr = (v) => String(v ?? '').trim();

export const getSalaryAccessCodeStatus = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.json({ set: false });
    const raw = await getSetting(salaryCodeKey(req.user.id));
    return res.json({ set: Boolean(raw) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createSalaryAccessCode = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.status(400).json({ message: 'Not authenticated.' });
    const existing = await getSetting(salaryCodeKey(req.user.id));
    if (existing) return res.status(409).json({ message: 'Access code already set.' });
    const code = codeToStr(req.body?.code);
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ message: 'Code must be exactly 4 digits.' });
    await upsertSetting(salaryCodeKey(req.user.id), code);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const verifySalaryAccessCode = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.json({ ok: false, message: 'Not authenticated.' });
    const code = codeToStr(req.body?.code);
    const stored = await getSetting(salaryCodeKey(req.user.id));
    if (!stored) return res.json({ ok: false, message: 'No access code set yet.' });
    return res.json({ ok: stored === code });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const changeSalaryAccessCode = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.status(400).json({ message: 'Not authenticated.' });
    const currentCode = codeToStr(req.body?.currentCode);
    const newCode = codeToStr(req.body?.newCode);
    if (!/^\d{4}$/.test(newCode)) return res.status(400).json({ message: 'New code must be exactly 4 digits.' });
    const key = salaryCodeKey(req.user.id);
    const stored = await getSetting(key);
    if (!stored) return res.status(404).json({ message: 'No access code set yet. Create one first.' });
    if (stored !== currentCode) return res.status(401).json({ message: 'Current access code is incorrect.' });
    await upsertSetting(key, newCode);
    return res.json({ ok: true, message: 'Access code changed successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerSalaries = async (req, res) => {
  try {
    const records = await getSalariesByWorker(req.params.workerId);
    return res.json(records);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addSalary = async (req, res) => {
  try {
    const { worker_id, salary, from_month, to_month } = req.body;
    if (!worker_id || salary == null || !from_month) {
      return res.status(400).json({ message: 'worker_id, salary, and from_month are required' });
    }
    const salNum = Number(salary);
    if (!Number.isFinite(salNum) || salNum <= 0) {
      return res.status(400).json({ message: 'salary must be a positive number' });
    }
    if (!/^\d{4}-\d{2}-01$/.test(from_month)) {
      return res.status(400).json({ message: 'from_month must be in YYYY-MM-01 format' });
    }
    if (to_month != null && !/^\d{4}-\d{2}-01$/.test(to_month)) {
      return res.status(400).json({ message: 'to_month must be in YYYY-MM-01 format' });
    }
    // An end month before the start month is an impossible range, and the salary
    // helpers treat a row with to_month set as CLOSED. Storing one silently makes
    // the worker look like they have no active salary, which zeroes their
    // auto-derived target (and any incentive that reads it) with no visible error.
    // from_month == to_month is fine: the range is inclusive, so that is a
    // single-month salary.
    if (to_month != null && to_month < from_month) {
      return res.status(400).json({ message: 'to_month cannot be earlier than from_month' });
    }
    const existing = await getSalariesByWorker(worker_id);
    const newMonth = from_month.slice(0, 7);
    for (const s of existing) {
      const sFrom = s.from_month.slice(0, 7);
      const sTo = s.to_month ? s.to_month.slice(0, 7) : '9999-12';
      if (newMonth >= sFrom && newMonth <= sTo) {
        return res.status(400).json({ message: 'Salary record for this month already exists for this worker' });
      }
    }
    const record = await createSalary({
      worker_id,
      salary,
      from_month,
      to_month: to_month || null,
      created_by: req.user?.id || null,
    });
    return res.status(201).json({ message: 'Salary added', record });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editSalary = async (req, res) => {
  try {
    const { salary, from_month, to_month, extra_amount } = req.body;
    if (salary !== undefined) {
      const salNum = Number(salary);
      if (!Number.isFinite(salNum) || salNum <= 0) {
        return res.status(400).json({ message: 'salary must be a positive number' });
      }
    }
    if (from_month !== undefined && !/^\d{4}-\d{2}-01$/.test(from_month)) {
      return res.status(400).json({ message: 'from_month must be in YYYY-MM-01 format' });
    }
    if (to_month !== undefined && to_month !== null && !/^\d{4}-\d{2}-01$/.test(to_month)) {
      return res.status(400).json({ message: 'to_month must be in YYYY-MM-01 format' });
    }
    const updates = {};
    if (salary !== undefined) updates.salary = salary;
    if (from_month !== undefined) updates.from_month = from_month;
    if (to_month !== undefined) updates.to_month = to_month;
    if (extra_amount !== undefined) updates.extra_amount = extra_amount;
    // Validate the range that would RESULT from this edit, not just each field on
    // its own: moving from_month alone can invert an already-correct row.
    const current = await getSalaryById(req.params.id);
    if (!current) {
      return res.status(404).json({ message: 'Salary record not found' });
    }
    const nextFrom = updates.from_month ?? current.from_month;
    const nextTo = updates.to_month !== undefined ? updates.to_month : current.to_month;
    if (nextTo != null && String(nextTo) < String(nextFrom)) {
      return res.status(400).json({ message: 'to_month cannot be earlier than from_month' });
    }
    const record = await updateSalary(req.params.id, updates);
    return res.json({ message: 'Salary updated', record });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkersSummary = async (req, res) => {
  try {
    const data = await getAllWorkersSalarySummary();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const paySalary = async (req, res) => {
  try {
    const existing = await getSalaryById(req.params.id);
    if (existing && existing.paid_at) {
      return res.status(400).json({ message: 'Salary is already marked as paid' });
    }
    const record = await updateSalary(req.params.id, { paid_at: new Date().toISOString() });
    return res.json({ message: 'Salary marked as paid', record });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerSalaryWithAllocations = async (req, res) => {
  try {
    const { workerId } = req.params;
    const monthQuery = req.query.month;

    const worker = await getWorkerById(workerId);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });

    // Determine month bounds
    let year, month, startDate, endDate, daysInMonth;
    if (monthQuery) {
      const p = monthQuery.split('-');
      year = parseInt(p[0]);
      month = parseInt(p[1]) - 1;
      startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    } else {
      const bounds = getISTMonthBounds();
      year = bounds.year;
      month = bounds.month;
      startDate = bounds.startDate;
      endDate = bounds.endDate;
      daysInMonth = bounds.daysInMonth;
    }

    const allocations = await getAllocationsByWorker(workerId);
    const activeSalary = await getActiveSalaryByWorker(workerId);
    const totalSalary = activeSalary ? parseFloat(activeSalary.salary) : 0;
    const perDay = totalSalary > 0 ? totalSalary / daysInMonth : 0;

    // Attendance for the month
    const records = await getMonthlyAttendance(workerId, startDate, endDate);

    // Sunday rule (all workers): every worked Sunday (incl. a cancelled one) is paid + (total−1) free
    let sundayBonus = {
      totalSundays: 0,
      attendedSundays: 0,
      paidSundays: 0,
      sundayAchievement: 0,
      sundayAKI: 0,
      incentiveAKI: 0,
      incentiveMonthly: 0,
      incentiveTotal: 0,
    };

    if (totalSalary > 0) {
      try {
        const createdAt = new Date(worker.created_at);
        const joinedThisMonth = createdAt.getFullYear() === year && createdAt.getMonth() === month;
        const joinDay = createdAt.getUTCDate();
        const lateJoin = joinedThisMonth && joinDay > 10;
        const sundayStats = computeSundayStats({
          year,
          month,
          daysInMonth,
          records,
          skipBeforeDate: joinedThisMonth
            ? `${year}-${String(month + 1).padStart(2, '0')}-${String(joinDay).padStart(2, '0')}`
            : null,
          lateJoin,
        });
        const achievements = await getMergedDailyAmounts(workerId, startDate, endDate);

        // Sunday AKI — each worked Sunday (including a cancelled one) earns its own AKI
        const isAttended = (s) => {
          const rec = records.find(r => r.date === s);
          return !!rec && (rec.status === 'present' || rec.status === 'late');
        };
        let sundayAchievement = 0;
        let sundayAKI = 0;
        for (const s of [...sundayStats.eligibleSundays, ...sundayStats.cancelledSundays]) {
          if (!isAttended(s)) continue;
          const ach = achievements.find(r => r.date === s);
          const amt = ach ? parseFloat(ach.amount || 0) : 0;
          sundayAchievement += amt;
          sundayAKI += (ach ? ach.aki : 0);
        }

        // Incentive totals (AKI + monthly, FRO only)
        let incentiveAKI = 0;
        let incentiveMonthly = 0;
        if (worker.department === 'FRO') {
          const monthStr = startDate;
          let tgt = await getTarget(workerId, monthStr);
          if (!tgt) {
            const monthsEmployed = getMonthsEmployed(worker.created_at, new Date(year, month + 1, 0));
            const multipliers = [1, 2.5, 3];
            const idx = Math.min(Math.max(monthsEmployed - 1, 0), multipliers.length - 1);
            tgt = await upsertTarget({
              worker_id: workerId,
              month: monthStr,
              target_amount: Math.round(totalSalary * multipliers[idx]),
              is_auto_generated: true,
            });
          }
          const currentTarget = parseFloat(tgt.target_amount);
          const monthlyAchievement = achievements.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
          const isNewJoiner = getMonthsEmployed(worker.created_at, new Date(year, month + 1, 0)) <= 3;
          const totalAKI = achievements.reduce((sum, r) => sum + (r.aki || 0), 0);
          if (monthlyAchievement >= currentTarget) {
            incentiveAKI = isNewJoiner ? totalAKI : Math.round(totalAKI / 2);
            incentiveMonthly = Math.round((monthlyAchievement - currentTarget) * 0.1);
          }
        }

        sundayBonus = {
          totalSundays: sundayStats.totalSundays,
          attendedSundays: sundayStats.attendedSundays,
          paidSundays: sundayStats.paidSundays,
          sundayAchievement: Math.round(sundayAchievement),
          sundayAKI,
          incentiveAKI,
          incentiveMonthly,
          incentiveTotal: incentiveAKI + incentiveMonthly,
        };
      } catch (err) { console.error('Sunday bonus calculation error:', err); }
    }

    // Loan / Advance deductions
    let loanDeductions = [];
    let totalLoanDeduction = 0;
    try {
      const activeLoans = await getActiveLoansByWorker(workerId);
      for (const loan of activeLoans) {
        const monthly = parseFloat(loan.monthly_deduction || 0);
        if (monthly > 0) {
          loanDeductions.push({
            id: loan.id,
            type: loan.type,
            total_amount: parseFloat(loan.total_amount),
            monthly_deduction: monthly,
            remaining_amount: parseFloat(loan.remaining_amount),
          });
          totalLoanDeduction += monthly;
        }
      }
    } catch (err) { console.error('Loan deduction error:', err); }

    return res.json({
      workerId: worker.id,
      name: worker.name,
      department: worker.department,
      totalSalary,
      perDay: Math.round(perDay),
      daysInMonth,
      allocations: allocations.map(a => ({
        id: a.id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || null,
        salary_portion: parseFloat(a.salary_portion),
      })),
      sundayBonus,
      loanDeductions,
      totalLoanDeduction,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeSalary = async (req, res) => {
  try {
    const result = await deleteSalary(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getPayrollExport = async (req, res) => {
  try {
    const month = req.query.month;
    const extended = req.query.extended === 'true';
    const data = await getPayrollData(month, extended);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getPresentDaysExport = async (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ message: 'month query param is required (YYYY-MM)' });
    const data = await getPresentDaysByMonth(month);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getPagarExport = async (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ message: 'month query param is required (YYYY-MM)' });
    const data = await getPagarExportData(month);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Per-worker attendance + deduction report as a downloadable .docx.
// Figures come from the payroll paid-day engine (utils/salaryDays.js), so they
// match the Salary File export for the same month.
export const downloadAttendanceReport = async (req, res) => {
  try {
    const month = req.query.month || null;
    if (month && !/^\d{4}-\d{2}$/.test(String(month))) {
      return res.status(400).json({ message: 'month must be formatted as YYYY-MM' });
    }
    const report = await getWorkerAttendanceReport(req.params.workerId, month);
    if (!report) return res.status(404).json({ message: 'Worker not found' });

    const buffer = renderAttendanceReportDocx(report);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report)}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAccountsSalaryCompensations = async (req, res) => {
  try {
    return res.json({ compensations: await getSalaryCompensations() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const saveAccountsSalaryCompensations = async (req, res) => {
  try {
    const compensations = await saveSalaryCompensations(req.body?.compensations);
    return res.json({ message: 'Salary compensations saved', compensations });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

export const getWorkerAttendance = async (req, res) => {
  try {
    const { month, name } = req.query;
    if (!month || !name) return res.status(400).json({ message: 'month and name query params are required (YYYY-MM)' });
    const data = await getWorkerAttendanceByName(month, name);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const ATTENDANCE_STATUSES = ['present', 'late', 'half-day', 'absent'];

export const updateWorkerAttendance = async (req, res) => {
  try {
    const { worker_id, date, status, late_minutes } = req.body;
    if (!worker_id || !date) {
      return res.status(400).json({ message: 'worker_id and date are required' });
    }
    if (!ATTENDANCE_STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
    }
    if (late_minutes != null && (!Number.isFinite(Number(late_minutes)) || Number(late_minutes) < 0)) {
      return res.status(400).json({ message: 'late_minutes must be a non-negative number' });
    }
    const record = await upsertAttendanceStatus(
      worker_id,
      date,
      status,
      late_minutes != null ? Number(late_minutes) : null
    );
    return res.json({ message: 'Attendance updated', attendance: record });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

function getISTMonthBounds() {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const startDate = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const endDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { year: y, month: m, startDate, endDate, daysInMonth: lastDay };
}

function getSundayCount(dateStrings) {
  return dateStrings.filter(d => new Date(d + 'T00:00:00Z').getUTCDay() === 0).length;
}

export const getMySalaryBreakdown = async (req, res) => {
  try {
    const workerId = req.user.id;
    const worker = await getWorkerById(workerId);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });

    const activeSalary = await getActiveSalaryByWorker(workerId);
    if (!activeSalary) return res.json({ hasSalary: false, message: 'No salary record found' });

    const { year, month, startDate, endDate, daysInMonth } = getISTMonthBounds();
    const records = await getMonthlyAttendance(workerId, startDate, endDate);

    let holidayDates = [];
    try {
      holidayDates = (await getHolidaysInRange(startDate, endDate)).map(h => h.date);
    } catch (err) { console.error('Holiday fetch error:', err.message); }

    const calc = computePaidDays({ year, month, daysInMonth, records, createdAt: worker.created_at, holidayDates, lateGraceMinutes: worker.late_grace_minutes ?? null });
    const { paidDays, totalDueDays, lateDeductionDays, lateGraceMinutes, lateThresholds, sundayDeductionDays, joiningDeduction, halfDayCount, totalLateMinutes, joinedThisMonth, joinDay, deducted, absentDatesAfterJoin, extraSundays, sundayStats } = calc;
    const perDay = parseFloat(activeSalary.salary) / daysInMonth;
    const salary = parseFloat(activeSalary.salary);

    const totalDue = perDay * totalDueDays;
    const normalTotalDue = perDay * paidDays;

    // FRO target + incentives
    let currentTarget = null;
    let incentiveAKI = 0;
    let incentiveAKIPayout = 0;
    let incentiveMonthly = 0;
    let incentiveTotal = 0;
    let monthlyAchievement = 0;
    let monthlyTargetMet = false;
    let isNewJoiner = false;

    if (worker.department === 'FRO') {
      try {
        const month = startDate;
        let tgt = await getTarget(workerId, month);
        if (!tgt) {
          const monthsEmployed = getMonthsEmployed(worker.created_at, new Date(year, month + 1, 0));
          const multipliers = [1, 2.5, 3];
          const idx = Math.min(Math.max(monthsEmployed - 1, 0), multipliers.length - 1);
          const targetAmount = Math.round(salary * multipliers[idx]);
          tgt = await upsertTarget({
            worker_id: workerId,
            month,
            target_amount: targetAmount,
            is_auto_generated: true,
          });
        }
        currentTarget = parseFloat(tgt.target_amount);

        const achievements = await getMergedDailyAmounts(workerId, startDate, endDate);
        monthlyAchievement = achievements.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

        incentiveAKI = achievements.reduce((sum, r) => sum + (r.aki || 0), 0);

        isNewJoiner = getMonthsEmployed(worker.created_at, new Date(year, month + 1, 0)) <= 3;
        monthlyTargetMet = monthlyAchievement >= currentTarget;

        if (monthlyTargetMet) {
          const overage = monthlyAchievement - currentTarget;
          incentiveMonthly = Math.round(overage * 0.1);
          incentiveAKIPayout = isNewJoiner ? incentiveAKI : Math.round(incentiveAKI / 2);
          incentiveTotal = incentiveAKIPayout + incentiveMonthly;
        }
      } catch (err) { console.error('Incentive calculation error:', err); }
    }

    // Loan / Advance deductions
    let loanDeductions = [];
    let totalLoanDeduction = 0;
    try {
      const activeLoans = await getActiveLoansByWorker(workerId);
      for (const loan of activeLoans) {
        const monthly = parseFloat(loan.monthly_deduction || 0);
        if (monthly > 0) {
          loanDeductions.push({
            id: loan.id,
            type: loan.type,
            total_amount: parseFloat(loan.total_amount),
            monthly_deduction: monthly,
            remaining_amount: parseFloat(loan.remaining_amount),
          });
          totalLoanDeduction += monthly;
        }
      }
    } catch (err) { console.error('Loan deduction error:', err); }

    const safeRecord = (r) => ({
      id: r.id, date: r.date, status: r.status, late_minutes: r.late_minutes || 0,
      punch_in_time: r.punch_in_time, punch_out_time: r.punch_out_time,
    });

    // Build per-NGO allocation breakdown
    let allocations = [];
    try {
      const rows = await getAllocationsByWorker(workerId);
      allocations = rows.map(r => {
        const portion = parseFloat(r.salary_portion);
        const allocPerDay = portion / daysInMonth;
        const allocTotalDue = allocPerDay * totalDueDays;
        return {
          id: r.id,
          ngo_id: r.ngo_id,
          ngo_name: r.ngos?.name || null,
          salary_portion: portion,
          perDay: Math.round(allocPerDay),
          totalDue: Math.round(allocTotalDue),
        };
      });
    } catch (err) { console.error('Failed to load allocations:', err); }

    return res.json({
      hasSalary: true,
      salary,
      perDay: Math.round(perDay),
      daysInMonth,
      availableDays: joinedThisMonth ? (daysInMonth - joinDay + 1) : daysInMonth,
      paidDays,
      finalPaidDays: totalDueDays,
      halfDayCount,
      totalLateMinutes,
      lateDeductionDays,
      lateGraceMinutes,
      lateThresholds,
      sundayDeductionDays,
      joiningDeduction,
      totalDue: Math.round(totalDue),
      normalTotalDue: Math.round(normalTotalDue),
      joinedThisMonth,
      joinDay,
      deductedCount: deducted.size,
      absentCount: absentDatesAfterJoin.length,
      absentDates: absentDatesAfterJoin,
      extraSundayCount: extraSundays.length,
      sundayCount: sundayStats.totalSundays,
      attendedSundayCount: sundayStats.attendedSundays,
      paidSundayCount: sundayStats.paidSundays,
      currentTarget,
      incentiveAKI,
      incentiveAKIPayout,
      incentiveMonthly,
      incentiveTotal,
      monthlyAchievement,
      monthlyTargetMet,
      isNewJoiner,
      createdAt: worker.created_at,
      records: (records || []).map(safeRecord),
      allocations,
      loanDeductions,
      totalLoanDeduction,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Per-month salary hold (Hold/Released). Only the accounts role can write;
// reads are allowed for HR/accounts/super-admin so the detail page can show
// the flag. "Released" is the default = simply no row for that month.
// ---------------------------------------------------------------------------
const assertAccountsWrite = (req, res) => {
  if (req.user?.role !== 'accounts' && req.user?.role !== 'super_admin') {
    res.status(403).json({ message: 'Only accounts can set Hold/Released' });
    return false;
  }
  return true;
};

const isValidSalaryMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));

export const getSalaryHold = async (req, res) => {
  try {
    const { workerId } = req.params;
    const month = req.query.month;
    if (!workerId) return res.status(400).json({ message: 'workerId is required' });
    if (!isValidSalaryMonth(month)) return res.status(400).json({ message: 'month is required (YYYY-MM)' });
    const { data, error } = await db
      .from('salary_holds')
      .select('id, worker_id, salary_month, reason, held_by, held_at')
      .eq('worker_id', workerId)
      .eq('salary_month', month)
      .limit(1);
    if (error) throw error;
    const hold = (data && data[0]) || null;
    return res.json({
      held: !!hold,
      reason: hold?.reason || '',
      held_at: hold?.held_at || null,
      held_by: hold?.held_by || null,
      worker_id: workerId,
      salary_month: month,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setSalaryHold = async (req, res) => {
  if (!assertAccountsWrite(req, res)) return;
  try {
    const { worker_id, salary_month, reason } = req.body || {};
    if (!worker_id) return res.status(400).json({ message: 'worker_id is required' });
    if (!isValidSalaryMonth(salary_month)) return res.status(400).json({ message: 'salary_month is required (YYYY-MM)' });
    const { data, error } = await db
      .from('salary_holds')
      .insert([{
        worker_id,
        salary_month: String(salary_month),
        reason: reason ? String(reason).trim() : null,
        held_by: req.user?.id || null,
      }])
      .select()
      .single();
    if (error) throw error;
    return res.status(201).json({ held: true, hold: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const releaseSalaryHold = async (req, res) => {
  if (!assertAccountsWrite(req, res)) return;
  try {
    const { workerId } = req.params;
    const month = req.query.month;
    if (!workerId) return res.status(400).json({ message: 'workerId is required' });
    if (!isValidSalaryMonth(month)) return res.status(400).json({ message: 'month is required (YYYY-MM)' });
    const { error } = await db
      .from('salary_holds')
      .delete()
      .eq('worker_id', workerId)
      .eq('salary_month', month);
    if (error) throw error;
    return res.json({ held: false, message: 'Salary released' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
