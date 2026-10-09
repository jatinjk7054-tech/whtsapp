import { getMonthsEmployed } from './incentive.js';
import { calcLateDeductionDays, getLateThresholds, resolveLateGrace } from './latePolicy.js';

const pad = n => String(n).padStart(2, '0');

// Accounts payroll compensation calendar. A compensatory Sunday replaces the
// linked holiday; it does not satisfy the separate compulsory-Sunday quota.
export const COMPENSATORY_WORKDAYS = {
  '2026-08': [{ workDate: '2026-08-23', holidayDate: '2026-08-28', name: 'Rashabandhan' }],
};

export function getCompensatoryWorkdays(month) {
  return COMPENSATORY_WORKDAYS[month] || [];
}

// Current date in IST as { year, month (0-based), day }.
export function getISTToday() {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + IST_OFFSET);
  return { year: now.getUTCFullYear(), month: now.getUTCMonth(), day: now.getUTCDate() };
}

export function shiftDate(dateStr, days) {
  const dt = new Date(dateStr + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Mirrors computeSundayStats() — every worked Sunday (present/late, even a
// cancelled one) is paid. A clean month also pays every non-worked Sunday;
// once absences or a late join trigger the Sunday policy, the normal free pool
// and compulsory Sunday deduction apply.
export function computeSundayStats({ year, month, daysInMonth, records, skipBeforeDate, lateJoin, hasCompensatoryWorkday = false }) {
  const inRange = (dateStr) => !skipBeforeDate || dateStr >= skipBeforeDate;
  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    dates.push({ date: dateStr, dayName: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dateStr + 'T00:00:00Z').getUTCDay()] });
  }

  const sundays = [];
  const cancelled = new Map(); // sunday date -> { type: 'clubbed', cause } | { type: 'extra' }
  let regularAbsences = 0;
  for (const day of dates) {
    if (day.dayName === 'Sun') { sundays.push(day.date); continue; }
    if (!inRange(day.date)) continue;
    const rec = records.find(r => r.date === day.date);
    if (rec?.status === 'absent' || rec?.status === 'leave') {
      regularAbsences++;
      if (day.dayName === 'Sat') {
        const ns = shiftDate(day.date, 1);
        if (inRange(ns)) cancelled.set(ns, { type: 'clubbed', cause: day.date });
      } else if (day.dayName === 'Mon') {
        const ps = shiftDate(day.date, -1);
        if (inRange(ps)) cancelled.set(ps, { type: 'clubbed', cause: day.date });
      }
    }
  }

  const totalSundays = sundays.filter(inRange);
  const extraSundays = [];
  if (regularAbsences >= 6 || lateJoin) {
    for (const s of totalSundays) {
      if (!cancelled.has(s)) {
        cancelled.set(s, { type: 'extra' });
        extraSundays.push(s);
      }
    }
  }

  const eligibleSundays = totalSundays.filter(s => !cancelled.has(s));
  const isAttended = (s) => {
    const rec = records.find(r => r.date === s);
    return !!rec && (rec.status === 'present' || rec.status === 'late' || rec.status === 'half-day');
  };
  const attendedEligible = eligibleSundays.filter(isAttended);
  const attendedCancelled = totalSundays.filter(s => cancelled.has(s) && isAttended(s));
  const workedAll = attendedEligible.length + attendedCancelled.length;
  const eligibleNotWorked = eligibleSundays.length - attendedEligible.length;
  const cleanMonth = regularAbsences === 0 && !lateJoin && !hasCompensatoryWorkday;
  const freeSundayLimit = cleanMonth ? totalSundays.length : Math.max(0, totalSundays.length - 1);
  const baseline = Math.max(0, Math.min(freeSundayLimit, eligibleNotWorked));
  const paidSundays = workedAll + baseline;
  const unpaidCount = eligibleNotWorked - baseline;
  const attendedEligibleSet = new Set(attendedEligible);
  const unpaidSundays = eligibleSundays.filter(s => !attendedEligibleSet.has(s)).slice(0, unpaidCount);

  return {
    totalSundays: totalSundays.length,
    attendedSundays: workedAll,
    attendedCancelledDates: attendedCancelled,
    paidSundays,
    eligibleSundays,
    cancelledSundays: totalSundays.filter(s => cancelled.has(s)),
    cancelledDetails: totalSundays.filter(s => cancelled.has(s)).map(s => ({ date: s, ...cancelled.get(s) })),
    extraSundays,
    unpaidSundays,
  };
}

// Full paid-days computation — mirrors getMySalaryBreakdown() in
// salaryController.js. `records` are the worker's attendance rows
// ({ date, status, late_minutes }) for the month; `createdAt` is the worker's
// created_at. `month` is 0-based.
export function computePaidDays({ year, month, daysInMonth, records, createdAt, holidayDates, viewingToday, includeHolidayPay = false, compensatoryWorkdays = [], lateGraceMinutes }) {
  const lateGrace = resolveLateGrace(lateGraceMinutes);
  const lateThresholds = getLateThresholds(lateGrace);
  const joinDate = createdAt ? new Date(createdAt) : null;
  const joinedThisMonth = joinDate && !isNaN(joinDate.getTime())
    ? joinDate.getFullYear() === year && joinDate.getMonth() === month
    : false;
  const joinDay = joinedThisMonth ? joinDate.getUTCDate() : 1;
  const joinDateStr = `${year}-${pad(month + 1)}-${pad(joinDay)}`;

  const afterJoin = joinedThisMonth ? records.filter(r => r.date >= joinDateStr) : records;
  const halfDayCount = afterJoin.filter(r => r.status === 'half-day').length;
  const presentDays = afterJoin.filter(r => r.status === 'present' || r.status === 'late').length;

  const monthDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
    monthDays.push({ date: dateStr, day: d, dayName: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dateStr + 'T00:00:00Z').getUTCDay()] });
  }

  const beforeJoin = joinedThisMonth ? monthDays.filter(d => d.date < joinDateStr) : [];
  const beforeJoinSet = new Set(beforeJoin.map(d => d.date));

  // A weekday with no attendance record counts as absent (same rule as the HR
  // salary page), unless it is a holiday or still in the future of the month.
  const holidaySet = new Set((holidayDates || []).map(d => String(d).slice(0, 10)));
  const { year: ty, month: tm, day: td } = getISTToday();
  const viewDay = viewingToday != null
    ? viewingToday
    : (ty === year && tm === month ? td : daysInMonth + 1);

  const realByDate = new Set(records.map(r => r.date));
  const fabricated = [];
  for (const day of monthDays) {
    if (beforeJoinSet.has(day.date)) continue;
    if (day.dayName === 'Sun') continue;
    if (holidaySet.has(day.date)) continue;
    if (day.day > viewDay) continue;
    if (!realByDate.has(day.date)) fabricated.push({ date: day.date, status: 'absent' });
  }
  const records2 = [...records, ...fabricated];
  const compensationByWorkDate = new Map((compensatoryWorkdays || []).map((entry) => [entry.workDate, entry]));
  const compensationByHolidayDate = new Map((compensatoryWorkdays || []).map((entry) => [entry.holidayDate, entry]));
  const sundayRecords = records2.filter((record) => !compensationByWorkDate.has(record.date));

  const deducted = new Set();

  for (const day of monthDays) {
    if (beforeJoinSet.has(day.date)) continue;
    if (day.dayName === 'Sun') continue;
    const rec = records2.find(r => r.date === day.date);
    if (rec?.status === 'absent' || rec?.status === 'leave') {
      deducted.add(day.date);
      if (day.dayName === 'Sat') {
        const ns = shiftDate(day.date, 1);
        if (!beforeJoinSet.has(ns)) deducted.add(ns);
      } else if (day.dayName === 'Mon') {
        const ps = shiftDate(day.date, -1);
        if (!beforeJoinSet.has(ps)) deducted.add(ps);
      }
    }
  }

  const lateJoin = joinedThisMonth && joinDay > 10;
  const sundayStats = computeSundayStats({
    year,
    month,
    daysInMonth,
    records: sundayRecords,
    skipBeforeDate: joinedThisMonth ? joinDateStr : null,
    lateJoin,
    hasCompensatoryWorkday: compensationByWorkDate.size > 0,
  });
  for (const d of sundayStats.unpaidSundays) deducted.add(d);
  for (const d of sundayStats.extraSundays) deducted.add(d);

  const available = Math.min(daysInMonth, viewDay) - (joinedThisMonth ? (joinDay - 1) : 0);
  const leaveCount = afterJoin.filter(r => r.status === 'leave').length;
  const totalLateMinutes = afterJoin.reduce((sum, r) => sum + (r.late_minutes || 0), 0);
  const lateDeductionDays = calcLateDeductionDays(totalLateMinutes, lateGrace);

  const joiningDeduction = (joinedThisMonth && getMonthsEmployed(createdAt, new Date(year, month + 1, 0)) <= 3) ? 1.5 : 0;

  const sundayReasons = [];
  const workedBackSet = new Set(sundayStats.attendedCancelledDates);
  for (const cd of sundayStats.cancelledDetails) {
    if (workedBackSet.has(cd.date)) continue;
    if (cd.type === 'clubbed') {
      sundayReasons.push({ date: cd.date, reason: `clubbed with ${cd.cause} (absent/leave)` });
    } else {
      sundayReasons.push({ date: cd.date, reason: 'extra (6+ absences or joined after the 10th)' });
    }
  }
  const freePool = Math.max(0, sundayStats.totalSundays - 1);
  for (const d of sundayStats.unpaidSundays) {
    sundayReasons.push({ date: d, reason: `not worked and beyond the free ${freePool} Sunday(s)` });
  }
  sundayReasons.sort((a, b) => (a.date < b.date ? -1 : 1));

  const sundayDeductionDays = [...deducted].filter(d => new Date(d + 'T00:00:00Z').getUTCDay() === 0).length;
  const freeSundayDays = Math.max(0, sundayStats.paidSundays - sundayStats.attendedSundays);
  const holidayPaidDays = includeHolidayPay
    ? monthDays.filter((day) => {
      if (!holidaySet.has(day.date) || beforeJoinSet.has(day.date) || day.day > viewDay) return false;
      const attendance = afterJoin.find((record) => record.date === day.date);
      const compensated = compensationByHolidayDate.get(day.date);
      if (!compensated) return !attendance || attendance.status === 'absent' || attendance.status === 'leave';
      const workRecord = afterJoin.find((record) => record.date === compensated.workDate);
      return !workRecord || !['present', 'late', 'half-day'].includes(workRecord.status);
    }).length
    : 0;
  const compensatoryWorkDays = [...compensationByWorkDate.keys()].filter((date) => {
    const record = afterJoin.find((entry) => entry.date === date);
    return record && ['present', 'late', 'half-day'].includes(record.status);
  }).length;
  const compensatedHolidayDays = [...compensationByHolidayDate.keys()].filter((date) => {
    const entry = compensationByHolidayDate.get(date);
    const record = afterJoin.find((item) => item.date === entry.workDate);
    return record && ['present', 'late', 'half-day'].includes(record.status);
  }).length;
  const requiredSundayWorkedDays = Math.min(1, sundayStats.attendedSundays);
  // Keep Sundays in the gross attendance basis. Worked Sundays are already
  // presentDays; the existing Sunday policy adds the free Sunday allowance.
  // Unpaid/extra Sundays are represented by sundayDeductionDays below.
  const grossPresentDays = presentDays + freeSundayDays + holidayPaidDays + sundayDeductionDays;

  return {
    joinedThisMonth,
    joinDay,
    available,
    presentRaw: presentDays,
    presentDays,
    halfDayCount,
    leaveCount,
    totalLateMinutes,
    lateDeductionDays,
    lateGraceMinutes: lateGrace,
    lateThresholds,
    joiningDeduction,
    sundayDeductionDays,
    deducted,
    deductedCount: deducted.size,
    absentDatesAfterJoin: records2.filter(r => r.status === 'absent').map(r => r.date),
    sundayAdd: sundayStats.attendedCancelledDates.length,
    extraSundays: sundayStats.extraSundays,
    clubbedSundays: sundayStats.cancelledSundays.length - sundayStats.extraSundays.length,
    extraSundayCount: sundayStats.extraSundays.length,
    freeSundays: Math.max(0, sundayStats.paidSundays - sundayStats.attendedSundays),
    holidayPaidDays,
    compensatoryWorkDays,
    compensatedHolidayDays,
    requiredSundayWorkedDays,
    sundayReasons,
    sundayStats,
    // Absent days are an attendance balance only. They are not subtracted
    // again because they are already excluded from presentDays.
    paidDays: grossPresentDays,
    totalDueDays: Math.max(0, grossPresentDays + halfDayCount * 0.5 - sundayDeductionDays - lateDeductionDays - joiningDeduction),
  };
}
