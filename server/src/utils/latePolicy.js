// Per-person late-deduction policy.
//
// One number is stored per worker: late_grace_minutes (NULL = default 180).
// The half-day and full-day limits scale proportionally with the grace so HR
// only ever edits a single value per person.
//
//   factor     = grace / 180
//   halfLimit  = round(240 * factor)
//   fullLimit  = round(480 * factor)   (also the proportional divisor)
//
// Example: grace 100 -> half 133, full 267.

export const DEFAULT_LATE_GRACE_MINUTES = 180;
const BASE_GRACE = 180;
const BASE_HALF = 240;
const BASE_FULL = 480;

export const MIN_LATE_GRACE_MINUTES = 30;
export const MAX_LATE_GRACE_MINUTES = 480;

export function normalizeLateGrace(value, fallback = DEFAULT_LATE_GRACE_MINUTES) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < MIN_LATE_GRACE_MINUTES || rounded > MAX_LATE_GRACE_MINUTES) return fallback;
  return rounded;
}

export function resolveLateGrace(workerOrValue, fallback = DEFAULT_LATE_GRACE_MINUTES) {
  if (workerOrValue != null && typeof workerOrValue === 'object') {
    const raw = workerOrValue.late_grace_minutes ?? workerOrValue.lateGraceMinutes ?? null;
    if (raw == null || raw === '') return fallback;
    return normalizeLateGrace(raw, fallback);
  }
  if (workerOrValue == null || workerOrValue === '') return fallback;
  return normalizeLateGrace(workerOrValue, fallback);
}

export function getLateThresholds(graceMinutes) {
  const grace = normalizeLateGrace(graceMinutes);
  const factor = grace / BASE_GRACE;
  const half = Math.max(1, Math.round(BASE_HALF * factor));
  const full = Math.max(half + 1, Math.round(BASE_FULL * factor));
  return { grace, half, full };
}

export function calcLateDeductionDays(totalLateMinutes, graceMinutes) {
  const total = Number(totalLateMinutes) || 0;
  if (total <= 0) return 0;
  const { grace, half, full } = getLateThresholds(graceMinutes);
  if (total > full) return Math.round((total / full) * 2) / 2;
  if (total > half) return 1;
  if (total > grace) return 0.5;
  return 0;
}
