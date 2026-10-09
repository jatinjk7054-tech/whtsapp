const IST_OFFSET_MINUTES = 330;

export function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute, second: +values.second };
}

export function istDateString(date = new Date()) {
  const p = istParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function istDayBounds(date = new Date()) {
  const p = istParts(date);
  const start = new Date(Date.UTC(p.year, p.month - 1, p.day) - IST_OFFSET_MINUTES * 60 * 1000);
  return { start, end: new Date(start.getTime() + 86400000 - 1) };
}

/**
 * The IST calendar month a moment belongs to, as 'YYYY-MM'.
 *
 * WHY THIS EXISTS. Several call sites used `new Date().toISOString().slice(0, 7)`
 * as the month key. toISOString() is UTC, and IST is UTC+5:30, so between 00:00
 * and 05:30 IST on the 1st of a month the UTC date is still the LAST day of the
 * previous month and this expression returns the wrong month. Wherever it sat
 * next to IST-derived monthStart/monthEnd bounds the two disagreed: the FRO was
 * shown the previous month's target against the current month's collection for
 * the first five and a half hours of every month.
 */
export function istMonthKey(date = new Date()) {
  const p = istParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/**
 * Start of the IST calendar month containing `date`, as a UTC instant.
 * 00:00 IST on the 1st, which is 18:30 UTC on the 30th of the previous month.
 */
export function istMonthStartUtc(date = new Date()) {
  const p = istParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, 1) - IST_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Every month-boundary value the monthly figures need, derived from ONE read of
 * the IST calendar so they cannot disagree with each other.
 *
 * `month` is the value fro_monthly_targets.month is keyed by — a DATE, so
 * 'YYYY-MM-01'. `startDay`/`endDay` are plain IST calendar days for the
 * date-typed columns. `start`/`end` are the instants for timestamptz ranges.
 */
export function istMonthBounds(date = new Date()) {
  const p = istParts(date);
  const start = istMonthStartUtc(date);
  const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  const end = new Date(Date.UTC(p.year, p.month, 0, 23, 59, 59, 999) - IST_OFFSET_MINUTES * 60 * 1000);
  return {
    monthKey: `${p.year}-${String(p.month).padStart(2, '0')}`,
    month: `${p.year}-${String(p.month).padStart(2, '0')}-01`,
    start,
    end,
    startDay: `${p.year}-${String(p.month).padStart(2, '0')}-01`,
    endDay: `${p.year}-${String(p.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function firstOfNextMonthIstUtc(date = new Date()) {
  const p = istParts(date);
  return new Date(Date.UTC(p.year, p.month, 1) - IST_OFFSET_MINUTES * 60 * 1000);
}

export function startOfNextIstDayUtc(date = new Date()) {
  const p = istParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + 1) - IST_OFFSET_MINUTES * 60 * 1000);
}
