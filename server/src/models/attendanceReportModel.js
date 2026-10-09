import db from '../config/db.js';
import { computePaidDays, getISTToday } from '../utils/salaryDays.js';
import { getMonthsEmployed } from '../utils/incentive.js';
import { getMergedDailyAmounts } from '../utils/dailyAchievementAggregator.js';
import { getTarget } from './incentiveModel.js';
import { getActiveSalaryByWorker, getSalaryCompensations } from './salaryModel.js';
import { getActiveLoansByWorker } from './loanModel.js';
import { getAllocationsByWorker } from './workerNgoAllocationModel.js';

// Per-worker attendance + deduction report.
//
// The paid-day math is NOT reimplemented here. It calls the same
// computePaidDays() from utils/salaryDays.js that backs the "Salary File"
// (pagar) export, with the same inputs — same viewingToday cap, same holiday
// calendar, same compensatory-workday settings — so the figures in the report
// are identical to payroll by construction rather than by duplicated logic.
// utils/salaryDays.js:105 is the single source of truth for paid days.

const pad = (n) => String(n).padStart(2, '0');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const STATUS_LABELS = {
  present: 'Present',
  late: 'Late',
  'half-day': 'Half Day',
  absent: 'Absent',
  leave: 'Leave',
  holiday: 'Holiday',
  sunday: 'Sunday',
  future: 'Upcoming',
};

function resolveMonth(month) {
  if (month) {
    const p = String(month).split('-');
    if (p.length !== 2 || !/^\d{4}$/.test(p[0]) || !/^\d{2}$/.test(p[1])) {
      throw new Error('month must be formatted as YYYY-MM');
    }
    const year = parseInt(p[0], 10);
    const monthIdx = parseInt(p[1], 10) - 1;
    if (monthIdx < 0 || monthIdx > 11) throw new Error('month must be formatted as YYYY-MM');
    return { year, monthIdx };
  }
  const ist = getISTToday();
  return { year: ist.year, monthIdx: ist.month };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function getWorkerAttendanceReport(workerId, month) {
  const { data: worker, error: wErr } = await db
    .from('workers')
    .select('id, name, login_id, email, department, employment_status, created_at, late_grace_minutes, ngo_id, account_holder_name, bank_name, account_number, ifsc_code, father_husband_name, photo_url')
    .eq('id', workerId)
    .maybeSingle();
  if (wErr) throw wErr;
  if (!worker) return null;

  const { year, monthIdx } = resolveMonth(month);
  const monthStr = `${year}-${pad(monthIdx + 1)}`;
  const startDate = `${monthStr}-01`;
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const endDate = `${monthStr}-${pad(daysInMonth)}`;

  // Same cap as the payroll export: the current month is only scored up to
  // today's IST day, so a mid-month report is provisional by definition.
  const ist = getISTToday();
  const isCurrentMonth = year === ist.year && monthIdx === ist.month;
  const viewingToday = isCurrentMonth ? ist.day : daysInMonth + 1;
  const provisional = isCurrentMonth && viewingToday <= daysInMonth;

  const [salaryRec, attendanceRes, holidayRes, compensationRes, loanRes, allocRes] = await Promise.all([
    getActiveSalaryByWorker(workerId).catch(() => null),
    db.from('attendance').select('*').eq('worker_id', workerId).gte('date', startDate).lte('date', endDate).order('date', { ascending: true }).then((r) => r.data || []).catch(() => []),
    db.from('holidays').select('date').gte('date', startDate).lte('date', endDate).then((r) => (r.data || []).map((h) => h.date)).catch(() => []),
    getSalaryCompensations().then((all) => all.filter((entry) => entry.month === monthStr)).catch(() => []),
    getActiveLoansByWorker(workerId).catch(() => []),
    getAllocationsByWorker(workerId).catch(() => []),
  ]);
  void attendanceRes;
  void holidayRes;

  const records = attendanceRes;
  const holidayDates = holidayRes;
  const compensations = compensationRes;

  const calc = computePaidDays({
    year,
    month: monthIdx,
    daysInMonth,
    records,
    createdAt: worker.created_at,
    holidayDates,
    viewingToday,
    includeHolidayPay: true,
    compensatoryWorkdays: compensations,
    lateGraceMinutes: worker.late_grace_minutes ?? null,
  });

  const salary = salaryRec ? parseFloat(salaryRec.salary) || 0 : 0;
  const perDay = daysInMonth > 0 ? salary / daysInMonth : 0;

  // ---- Day-by-day grid -------------------------------------------------
  const recordByDate = new Map(records.map((r) => [String(r.date).slice(0, 10), r]));
  const holidaySet = new Set(holidayDates.map((d) => String(d).slice(0, 10)));
  const compensationByWorkDate = new Map(compensations.map((c) => [c.workDate, c]));
  const compensationByHolidayDate = new Map(compensations.map((c) => [c.holidayDate, c]));
  const deductedSet = calc.deducted;

  const dailyRows = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${monthStr}-${pad(d)}`;
    const dayName = DAY_NAMES[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
    const rec = recordByDate.get(dateStr);
    const isBeforeJoin = calc.joinedThisMonth && dateStr < `${monthStr}-${pad(calc.joinDay)}`;

    let status;
    if (isBeforeJoin) status = 'not-joined';
    else if (rec && rec.status) status = rec.status;
    else if (dayName === 'Sun') status = 'sunday';
    else if (holidaySet.has(dateStr)) status = 'holiday';
    else if (d > viewingToday) status = 'future';
    else status = 'absent';

    let note = '';
    if (isBeforeJoin) note = 'Before date of joining';
    else if (compensationByWorkDate.has(dateStr)) note = `Compensatory workday for ${compensationByHolidayDate.get(compensationByWorkDate.get(dateStr).holidayDate)?.name || 'holiday'}`;
    else if (compensationByHolidayDate.has(dateStr)) note = `Holiday compensated on ${compensationByHolidayDate.get(dateStr).workDate}`;

    const sundayReason = (calc.sundayReasons || []).find((r) => r.date === dateStr);
    if (sundayReason && !note) note = sundayReason.reason;

    dailyRows.push({
      day: d,
      date: dateStr,
      dayName,
      status,
      statusLabel: STATUS_LABELS[status] || status,
      punchIn: rec?.punch_in_time ? new Date(rec.punch_in_time).toISOString() : null,
      punchOut: rec?.punch_out_time ? new Date(rec.punch_out_time).toISOString() : null,
      lateMinutes: rec?.late_minutes || 0,
      isHoliday: holidaySet.has(dateStr),
      isSunday: dayName === 'Sun',
      isDeducted: deductedSet.has(dateStr),
      note,
    });
  }

  // ---- Deduction line items -------------------------------------------
  const absentDates = dailyRows.filter((r) => r.status === 'absent').map((r) => r.date);
  const leaveDates = dailyRows.filter((r) => r.status === 'leave').map((r) => r.date);
  // Late minutes are POOLED across the whole month and then divided by the
  // full-day threshold (utils/latePolicy.js:calcLateDeductionDays). They are
  // NOT charged per individual day, so a per-date "you owe X" attribution would
  // be wrong. The log below is evidence only; the arithmetic is shown once.
  const lateRows = dailyRows
    .filter((r) => r.status === 'late' && (r.lateMinutes || 0) > 0)
    .map((r) => ({ date: r.date, minutes: r.lateMinutes || 0 }));

  let running = 0;
  const lateLog = lateRows.map((r) => {
    running += r.minutes;
    return { date: r.date, minutes: r.minutes, runningMinutes: running };
  });

  const fmtDate = (d) => {
    const [y, m, dd] = String(d).split('-');
    return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
  };

  const lateTotal = Number(calc.totalLateMinutes) || 0;
  const { grace: gMin, half: gHalf, full: gFull } = calc.lateThresholds || {};
  const rawDays = gFull ? lateTotal / gFull : 0;

  const lateExplanation = lateTotal
    ? [
      `POOLED MONTHLY RULE — late minutes are added together for the whole month, then divided by the full-day limit. Individual days are not charged separately.`,
      `1. Grace: the first ${gMin} minutes are free. This volunteer's personal grace is ${gMin} min (standard is 180 min).`,
      `2. Thresholds scale with grace: half-day at ${gHalf} min, full-day at ${gFull} min.`,
      `3. Total late: ${lateTotal} min across ${lateLog.length} day${lateLog.length === 1 ? '' : 's'} (average ${Math.round(lateTotal / lateLog.length)} min per late day).`,
      `4. Working: ${lateTotal} ÷ ${gFull} = ${rawDays.toFixed(2)} days, rounded to the nearest half day = ${round2(calc.lateDeductionDays)} days.`,
      `5. Money: ${round2(calc.lateDeductionDays)} × ₹${perDay.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per day = ₹${Math.round(perDay * calc.lateDeductionDays).toLocaleString('en-IN')}, deducted from gross pay.`,
    ].join('\n')
    : `No late minutes recorded, or all lateness fell within the ${gMin} min grace. No late deduction.`;

  // `affectsPay` marks the lines that actually reduce paid days. Absent and
  // leave days are an attendance balance only — they are already excluded from
  // presentDays (see the note in utils/salaryDays.js), so counting them again
  // in the money total would double-charge them.
  const deductions = [];
  const addDeduction = (label, days, detail, affectsPay = true) => {
    if (!days) return;
    deductions.push({
      label,
      days: round2(days),
      amount: Math.round(perDay * days),
      affectsPay,
      detail: detail || '',
    });
  };

  const BALANCE_NOTE = 'Attendance balance only — already excluded from present days, not deducted again';
  addDeduction('Absent days', absentDates.length, absentDates.length ? `Dates: ${absentDates.join(', ')} · ${BALANCE_NOTE}` : '', false);
  addDeduction('Leave days', leaveDates.length, leaveDates.length ? `Dates: ${leaveDates.join(', ')} · ${BALANCE_NOTE}` : '', false);
  addDeduction('Half days', calc.halfDayCount * 0.5, `Half day count: ${calc.halfDayCount} (credited as ${round2(calc.halfDayCount * 0.5)} day${calc.halfDayCount === 1 ? '' : 's'})`);
  addDeduction('Unpaid Sundays', (calc.sundayStats?.unpaidSundays || []).length, (calc.sundayStats?.unpaidSundays || []).length ? `Dates: ${(calc.sundayStats?.unpaidSundays || []).join(', ')}` : '');
  addDeduction('Extra Sundays', (calc.extraSundays || []).length, (calc.extraSundays || []).length ? `Dates: ${(calc.extraSundays || []).join(', ')}` : '');
  addDeduction('Late deduction', calc.lateDeductionDays, lateExplanation);
  addDeduction('Joining / training deduction', calc.joiningDeduction, calc.joinedThisMonth ? 'Joined this month within the first 3 months of employment' : '');

  // Only pay-affecting lines are summed into the money total.
  const payDeductions = deductions.filter((d) => d.affectsPay);
  const totalDeductionAmount = payDeductions.reduce((sum, d) => sum + d.amount, 0);
  const totalDeductionDays = round2(payDeductions.reduce((sum, d) => sum + d.days, 0));


  // ---- FRO incentives (FRO department only, mirrors the payroll row) ----
  let incentive = { applicable: false, target: 0, achieved: 0, monthly: 0, aki: 0, akiPayout: 0, total: 0, targetMet: false, daily: [] };
  if (worker.department === 'FRO') {
    try {
      const target = await getTarget(workerId, startDate);
      const targetAmount = target ? parseFloat(target.target_amount) || 0 : 0;
      const merged = await getMergedDailyAmounts(workerId, startDate, endDate);
      const achieved = merged.reduce((sum, r) => sum + r.amount, 0);
      const totalAKI = merged.reduce((sum, r) => sum + r.aki, 0);
      const monthsEmployed = getMonthsEmployed(worker.created_at, new Date(year, monthIdx + 1, 0));
      const isNewJoiner = monthsEmployed != null && monthsEmployed <= 3;
      const targetMet = targetAmount > 0 && achieved >= targetAmount;
      const monthly = targetMet ? Math.round((achieved - targetAmount) * 0.1) : 0;
      const akiPayout = targetMet ? (isNewJoiner ? Math.round(totalAKI) : Math.round(totalAKI / 2)) : 0;
      incentive = {
        applicable: true,
        target: targetAmount,
        achieved: Math.round(achieved),
        monthly,
        aki: Math.round(totalAKI),
        akiPayout,
        total: monthly + akiPayout,
        targetMet,
        daily: merged.map((r) => ({ date: r.date, amount: r.amount, aki: r.aki })),
      };
    } catch (err) {
      console.error('Attendance report incentive error:', err.message);
    }
  }

  // ---- Loans / advances ----------------------------------------------
  const loans = loanRes
    .filter((l) => parseFloat(l.monthly_deduction || 0) > 0)
    .map((l) => ({
      type: l.type,
      totalAmount: parseFloat(l.total_amount || 0),
      monthlyDeduction: parseFloat(l.monthly_deduction || 0),
      remainingAmount: parseFloat(l.remaining_amount || 0),
      startMonth: l.start_month,
      endMonth: l.end_month,
    }));
  const advanceDeduction = loans.reduce((sum, l) => sum + l.monthlyDeduction, 0);

  // ---- Totals (identical arithmetic to salaryModel.js:894-896) ---------
  const grossPresentDays = calc.paidDays;
  const netPresentDays = calc.totalDueDays;
  const monthSalary = Math.round(perDay * netPresentDays);
  const grossPayable = monthSalary + (incentive.applicable ? incentive.total : 0);
  const netPayable = Math.max(0, grossPayable - advanceDeduction);

  // NGO allocation rows with a non-zero portion. A worker can have allocation
  // rows saved with salary_portion = 0, which carry no split information; those
  // collapse into a single "Unallocated" line rather than a table of zeros
  // (the same fallback getPayrollData uses for an unallocated worker).
  const allocations = allocRes
    .filter((a) => parseFloat(a.salary_portion || 0) > 0)
    .map((a) => {
      const portion = parseFloat(a.salary_portion || 0);
      const allocPerDay = daysInMonth > 0 ? portion / daysInMonth : 0;
      return {
        ngoName: a.ngos?.name || 'Unknown',
        portion,
        perDay: Math.round(allocPerDay),
        totalDue: Math.round(allocPerDay * netPresentDays),
      };
    });

  const allocatedPortion = allocations.reduce((sum, a) => sum + a.portion, 0);
  if (allocRes.length > 0 && allocations.length === 0) {
    allocations.push({
      ngoName: 'Unallocated (no salary portion set)',
      portion: 0,
      perDay: 0,
      totalDue: 0,
    });
  } else if (allocRes.length > 0 && allocatedPortion > 0 && allocatedPortion < salary) {
    allocations.push({
      ngoName: 'Unallocated (remainder)',
      portion: Math.round((salary - allocatedPortion) * 100) / 100,
      perDay: Math.round((salary - allocatedPortion) / daysInMonth),
      totalDue: Math.round(((salary - allocatedPortion) / daysInMonth) * netPresentDays),
    });
  }

  const sundayStats = calc.sundayStats || {};
  const attendanceSummary = [
    { label: 'Days in month', value: daysInMonth },
    { label: 'Available (from join date)', value: calc.available },
    { label: 'Days worked (present + late)', value: calc.presentDays },
    { label: 'Half days', value: calc.halfDayCount },
    { label: 'Leave days', value: calc.leaveCount },
    { label: 'Absent days', value: absentDates.length },
    { label: 'Sundays in month', value: sundayStats.totalSundays || 0 },
    { label: 'Sundays worked', value: sundayStats.attendedSundays || 0 },
    { label: 'Sundays paid (incl. free allowance)', value: sundayStats.paidSundays || 0 },
    { label: 'Holiday paid days', value: calc.holidayPaidDays },
    { label: 'Compensatory work days', value: calc.compensatoryWorkDays },
    { label: 'Total late minutes', value: calc.totalLateMinutes },
    { label: 'Late grace minutes', value: calc.lateGraceMinutes },
  ];

  const paidSummary = [
    { label: 'Gross present days', value: round2(grossPresentDays) },
    { label: 'Half day credit', value: round2(calc.halfDayCount * 0.5) },
    { label: 'Sunday deduction (days)', value: -round2(calc.sundayDeductionDays) },
    { label: 'Late deduction (days)', value: -round2(calc.lateDeductionDays) },
    { label: 'Joining / training deduction (days)', value: -round2(calc.joiningDeduction) },
    { label: 'Net paid days', value: round2(netPresentDays) },
  ];

  return {
    worker: {
      id: worker.id,
      name: worker.name,
      loginId: worker.login_id,
      email: worker.email,
      department: worker.department,
      employmentStatus: worker.employment_status || 'active',
      dateOfJoining: worker.created_at ? String(worker.created_at).slice(0, 10) : null,
      accountHolderName: worker.account_holder_name,
      fatherHusbandName: worker.father_husband_name,
      bankName: worker.bank_name,
      accountNumber: worker.account_number,
      ifscCode: worker.ifsc_code,
    },
    month: {
      key: monthStr,
      year,
      monthIndex: monthIdx,
      label: `${MONTH_NAMES[monthIdx]} ${year}`,
      daysInMonth,
      startDate,
      endDate,
      viewingToday,
      isCurrentMonth,
      provisional,
    },
    salary: {
      monthly: salary,
      perDay: round2(perDay),
      effectiveFrom: salaryRec ? salaryRec.from_month : null,
    },
    attendanceSummary,
    paidSummary,
    dailyRows,
    deductions,
    lateLog,
    lateExplanation,
    totalDeductionAmount,
    totalDeductionDays,
    sundayStats: {
      totalSundays: sundayStats.totalSundays || 0,
      attendedSundays: sundayStats.attendedSundays || 0,
      paidSundays: sundayStats.paidSundays || 0,
      unpaidSundays: sundayStats.unpaidSundays || [],
      extraSundays: sundayStats.extraSundays || [],
      cancelledSundays: sundayStats.cancelledSundays || [],
      reasons: calc.sundayReasons || [],
    },
    incentives: incentive,
    loans,
    advanceDeduction,
    totals: {
      grossPresentDays: round2(grossPresentDays),
      netPresentDays: round2(netPresentDays),
      monthSalary,
      incentiveTotal: incentive.applicable ? incentive.total : 0,
      grossPayable,
      advanceDeduction: Math.round(advanceDeduction),
      netPayable,
    },
    allocations,
    generatedAt: new Date().toISOString(),
  };
}
