import { getAchievements } from '../models/dailyAchievementModel.js';
import { getDailyCollectionByWorker } from '../models/froDonorLogModel.js';
import { getDayName, calculateAKI, getAKISlabs } from './incentive.js';

// Merges manually-logged daily_achievements with the FRO's actual daily
// collections (fro_donor_logs) so HR/incentive views show the same per-day
// amounts as the FRO panel. Manual achievements win over collections.
export async function getMergedDailyAmounts(workerId, startDate, endDate, ranges) {
  const [achievements, collections, resolvedRanges] = await Promise.all([
    getAchievements(workerId, startDate, endDate),
    getDailyCollectionByWorker(workerId, `${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`).catch((err) => {
      console.error('getDailyCollectionByWorker failed:', err.message);
      return {};
    }),
    ranges ? Promise.resolve(ranges) : getAKISlabs(),
  ]);

  const byDate = {};
  for (const a of achievements || []) {
    byDate[a.date] = parseFloat(a.amount || 0);
  }
  for (const [date, amount] of Object.entries(collections || {})) {
    if (byDate[date] == null) byDate[date] = amount;
  }

  return Object.entries(byDate)
    .map(([date, amount]) => ({
      date,
      amount,
      dayName: getDayName(date),
      aki: calculateAKI(amount, getDayName(date), resolvedRanges),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Number(x) || 0 guards both null and non-numeric DB strings. A raw `sum + r.amount`
// yields NaN for a non-numeric string, and JSON.stringify serialises NaN as null,
// which crashes the client on `.toLocaleString()`.
export const sumDailyAmounts = (daily) => daily.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
export const sumDailyAKI = (daily) => daily.reduce((sum, r) => sum + (Number(r.aki) || 0), 0);
