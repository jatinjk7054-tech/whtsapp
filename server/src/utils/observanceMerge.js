/**
 * The four-source merge that powers the calendar and the Monthly Planner's
 * festival grid.
 *
 * Sources, merged in order (append-only; earlier sources win on exact
 * date+name duplicates):
 *   1. the curated reference calendar (observances.js) — deterministic
 *   2. operator-managed `holidays` rows (optional overlay, supplied by the
 *      caller so its DB-failure caching stays where it already lives)
 *   3. the fixed international days list (importantDays.js) — deterministic,
 *      ships with the deploy, needs no API
 *   4. Calendarific (India festivals/national days + worldwide/UN observance
 *      days) — cached once per country+year on disk and in memory
 *
 * Both the Important Days endpoint and the festival-suggestion validator read
 * this, so the grid and the AI validation can never disagree about what a real
 * festival/date is.
 *
 * Kept dependency-free of the controllers so it can be unit tested.
 */

import { getObservancesInRange, mergeCustomObservances } from './observances.js';
import { getInternationalDaysInRange } from './importantDays.js';
import { getCalendarificObservancesInRange, mergeCalendarific } from './calendarific.js';

/** 'india' for India-scoped rows, 'international' for worldwide ones. */
export const importantDayType = (o) => (o.scope === 'worldwide' ? 'international' : 'india');

/**
 * Every important day / festival / observance inside [startYmd, endYmd)
 * (endYmd exclusive), merged from all four sources and sorted by date then name.
 *
 * The `holidays` list is a graceful bonus: an empty array just means the merge
 * runs on the curated rows alone.
 *
 * @param {string} startYmd
 * @param {string} endYmd       exclusive end
 * @param {object} [opts]
 * @param {Array=} opts.holidays  operator-managed overlay rows
 * @param {('all'|'worldwide'|'india')=} opts.scope  filter by bucket (type),
 *                                                   matching listImportantDays
 */
export async function getMergedObservancesInRange(startYmd, endYmd, { holidays = [], scope = 'all' } = {}) {
  // 1 + 2. Curated reference calendar (both scopes) + operator holiday overlay.
  const curated = getObservancesInRange(startYmd, endYmd, { scope: 'all' });
  const base = Array.isArray(holidays) && holidays.length
    ? mergeCustomObservances(curated, holidays)
    : curated;

  // 3. Fixed international days (deduped — curated wins on exact date+name).
  const withFixed = mergeCalendarific(base, getInternationalDaysInRange(startYmd, endYmd), 'all');

  // 4. Calendarific (cached once per country+year; degrades to the rows above).
  const allRows = mergeCalendarific(
    withFixed,
    await getCalendarificObservancesInRange(startYmd, endYmd),
    'all',
  );

  if (scope === 'all') return allRows;

  const wantedType = scope === 'worldwide' ? 'international' : 'india';
  return allRows.filter((o) => importantDayType(o) === wantedType);
}

/** Case-insensitive lookup for a festival on one date, or null. */
export function findObservanceForDate(rows, dateYmd, name) {
  const list = Array.isArray(rows) ? rows : [];
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return list.find((o) => o && o.date === dateYmd && String(o.name || '').trim().toLowerCase() === want) || null;
}