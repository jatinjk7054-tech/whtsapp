// Target for a FRO inside their first three months, derived from their current
// salary: 1x in month one, 2.5x in month two, 3x in month three. From month four
// on it returns null and the target comes from the fro_monthly_targets row.
//
// NOTE ON THE COUNTING CONVENTION. monthsSinceJoining is 0-based: a FRO who
// joined today is month 0. That matches calculateAutoTarget, which is what
// getMyPerformance has always used. Do not swap it for getMonthsEmployed from
// utils/incentive.js — that one is 1-based (a FRO who joined today is month 1),
// so feeding its result to calculateAutoTarget would charge a brand-new joiner
// 2.5x salary instead of 1x.
//
// Pure and dependency-free so every surface that shows a FRO's target derives it
// the same way. This used to live inline in froController only, which is why the
// leaderboard showed 0 for every new hire while the FRO's own strip showed the
// correct number: the leaderboard only ever read fro_monthly_targets, and a new
// FRO's auto target is never stored there.
export function monthsSinceJoining(createdAt, refDate = new Date()) {
  const join = new Date(createdAt);
  if (Number.isNaN(join.getTime())) return null;
  const months = (refDate.getFullYear() - join.getFullYear()) * 12 + (refDate.getMonth() - join.getMonth());
  return refDate.getDate() >= join.getDate() ? months : months - 1;
}

export function calculateAutoTarget(salary, monthsEmployed) {
  if (monthsEmployed == null) return null;
  if (monthsEmployed <= 0) return salary * 1;
  if (monthsEmployed === 1) return salary * 2.5;
  if (monthsEmployed === 2) return salary * 3;
  return null;
}

// 'month1' | 'month2' | 'month3' | null, matching what getMyPerformance reports.
export function autoTargetMonthLabel(monthsEmployed) {
  if (monthsEmployed == null) return null;
  if (monthsEmployed <= 0) return 'month1';
  if (monthsEmployed === 1) return 'month2';
  if (monthsEmployed === 2) return 'month3';
  return null;
}
