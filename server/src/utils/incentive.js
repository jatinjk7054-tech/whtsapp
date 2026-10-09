import { getSetting, upsertSetting } from '../models/settingsModel.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const SETTINGS_KEY = 'aki_slabs';

export const AKI_RANGES = {
  Sunday: [
    { min: 3750, max: 6999, incentive: 200 },
    { min: 7000, max: 11999, incentive: 400 },
    { min: 12000, max: 13749, incentive: 800 },
    { min: 13750, max: 18999, incentive: 1100 },
    { min: 19000, max: Infinity, incentive: 1500 },
  ],
  Monday: [
    { min: 3000, max: 5999, incentive: 180 },
    { min: 6000, max: 8999, incentive: 360 },
    { min: 9000, max: 11999, incentive: 540 },
    { min: 12000, max: 13999, incentive: 720 },
    { min: 14000, max: Infinity, incentive: 900 },
  ],
  Tuesday: [
    { min: 2500, max: 7999, incentive: 100 },
    { min: 8000, max: 12499, incentive: 400 },
    { min: 12500, max: 15999, incentive: 700 },
    { min: 16000, max: Infinity, incentive: 1100 },
  ],
  Wednesday: [
    { min: 3000, max: 5499, incentive: 250 },
    { min: 5500, max: 7499, incentive: 300 },
    { min: 7500, max: 10499, incentive: 450 },
    { min: 10500, max: 12499, incentive: 610 },
    { min: 12500, max: Infinity, incentive: 750 },
  ],
  Thursday: [
    { min: 3750, max: 6999, incentive: 200 },
    { min: 7000, max: 11999, incentive: 400 },
    { min: 12000, max: 13749, incentive: 800 },
    { min: 13750, max: 18999, incentive: 1100 },
    { min: 19000, max: Infinity, incentive: 1500 },
  ],
  Friday: [
    { min: 3000, max: 5999, incentive: 180 },
    { min: 6000, max: 8999, incentive: 360 },
    { min: 9000, max: 11999, incentive: 540 },
    { min: 12000, max: 13999, incentive: 720 },
    { min: 14000, max: Infinity, incentive: 900 },
  ],
  Saturday: [
    { min: 2500, max: 3999, incentive: 100 },
    { min: 4000, max: 7999, incentive: 200 },
    { min: 8000, max: 12499, incentive: 400 },
    { min: 12500, max: 15999, incentive: 700 },
    { min: 16000, max: Infinity, incentive: 1100 },
  ],
};

export function getDayName(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    console.warn('getDayName: invalid dateStr', dateStr);
    return '';
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) {
    console.warn('getDayName: could not parse date', dateStr);
    return '';
  }
  return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}

export function calculateAKI(amount, dayName, ranges) {
  const dayRanges = (ranges || AKI_RANGES)[dayName];
  if (!dayRanges) return 0;
  const range = dayRanges.find(r => amount >= r.min && amount <= r.max);
  return range ? range.incentive : 0;
}

export function getMonthsEmployed(createdAt, refDate = new Date()) {
  const join = new Date(createdAt);
  if (isNaN(join.getTime())) return 99;
  const months = (refDate.getFullYear() - join.getFullYear()) * 12 + (refDate.getMonth() - join.getMonth());
  const isAfterJoinDay = refDate.getDate() >= join.getDate();
  return isAfterJoinDay ? months + 1 : months;
}

export function normalizeAKISlabs(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const day of DAY_NAMES) {
    let list = Array.isArray(source[day]) ? source[day] : [];
    list = list
      .filter(r => r && typeof r === 'object')
      .map(r => ({
        min: Number.isFinite(Number(r.min)) ? Number(r.min) : null,
        max: r.max === Infinity || r.max === null || Number(r.max) === Infinity ? Infinity : (Number.isFinite(Number(r.max)) ? Number(r.max) : null),
        incentive: Number.isFinite(Number(r.incentive)) ? Number(r.incentive) : null,
      }))
      .filter(r => r.min != null && r.incentive != null);
    out[day] = list.length ? list : AKI_RANGES[day];
  }
  return out;
}

export async function getAKISlabs() {
  const stored = await getSetting(SETTINGS_KEY);
  let parsed = null;
  try { parsed = stored ? JSON.parse(stored) : null; } catch { parsed = null; }
  return normalizeAKISlabs(parsed);
}

export async function persistAKISlabs(slabs) {
  const normalized = normalizeAKISlabs(slabs);
  await upsertSetting(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}
