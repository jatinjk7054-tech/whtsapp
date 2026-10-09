import db from '../config/db.js';
import { getShiftWindowMs, istDateStr, liveIdleSeconds, idlePeriodStartMs, counterDayOf, isCounterDayStale } from '../utils/froIdle.js';
import { dayTotalsForDate } from './froTimeSessions.js';

// Authoritative idle for a day, from the interval ledger. Returns null when the
// ledger has no rows for that day (migration not applied, or a day before the
// roll-out), so callers keep their legacy-derived fallback for that case.
export async function ledgerIdleForDate(workerId, dateStr, shift = null) {
  try {
    const { hasLedger, totals } = await dayTotalsForDate(workerId, dateStr, { shift });
    return hasLedger ? totals.idle_seconds : null;
  } catch (_) {
    return null;
  }
}

// Which day a row's counters belong to is asked by the WRITE paths here and by
// every READ path in froIdle, so the rule lives with the readers and is
// re-exported for the existing importers.
export { counterDayOf, isCounterDayStale };

/**
 * Which IST day do a live-status row's counters belong to, and has that changed?
 *
 * The bug this exists to end
 * -------------------------
 * fro_live_status is ONE row per worker carrying "today" counters, and every idle
 * write path stores it with GREATEST, so a stored value can only ever rise. The
 * day rollover used to clear those counters through a condition that only fired
 * when the worker was in an OPEN idle period at the boundary:
 *
 *     if (cleaned.idle_since === null && row.idle_since) payload.today_idle_seconds = 0;
 *
 * Finish a day with idle_since = NULL — resume, sign out, or the exit path banking
 * the period — and the reset never ran. Yesterday's total stayed in the counter,
 * today's idle was added on top of it, and the daily snapshot captured the running
 * total as one day. That is how 52h19m of idle ended up in a single row, and
 * because the snapshot is also GREATEST the value could never be walked back down.
 *
 * The rule now
 * ------------
 * A counter belongs to the day stamped in stats_date, full stop. If that is not
 * today, the old counters are snapshotted against the OLD day and the live row
 * starts today at zero. The rollover no longer consults idle_since at all, so it
 * cannot be skipped by whichever state the worker happened to leave behind.
 *
 * NOTE ON WHAT IS *NOT* DONE HERE. The previous day's counters are banked, not
 * discarded, because they are real shift time and the monthly salary figure sums
 * them. Deliberately not fixing up the historical inflation: that is a data
 * decision, not a code one.
 */

/** A single day cannot physically contain more than this much idle. */
export const MAX_IDLE_SECONDS_PER_DAY = 24 * 60 * 60;

// Exported so any path that re-arms a stale live row zeroes exactly the same set
// the rollover does - a partial list here is how yesterday's count survives into
// today under a fresh stats_date.
export const COUNTER_COLUMNS = [
  'today_calls',
  'today_talk_seconds',
  'today_break_seconds',
  'today_skipped',
];

// counterDayOf and isCounterDayStale now live in froIdle.js — see the note at
// the top of this file.

/**
 * Hard invariant: a day cannot hold more idle than it has hours.
 *
 * Applied on the way into fro_daily_stats so an over-count is unrepresentable
 * rather than merely unlikely. This is the backstop; the rollover above is what
 * makes the number right. A caller's own cap (the worker's real shift window)
 * is honoured when supplied, which is tighter still.
 */
export function capIdleSeconds(seconds, extraCapMs = NaN) {
  let cap = MAX_IDLE_SECONDS_PER_DAY;
  if (Number.isFinite(extraCapMs) && extraCapMs >= 0) {
    cap = Math.min(cap, Math.round(extraCapMs / 1000));
  }
  return Math.max(0, Math.min(Math.round(Number(seconds) || 0), cap));
}

/**
 * The single place fro_daily_stats is written.
 *
 * All four idle write paths used to carry their own copy of this upsert. That is
 * how the cap and the day attribution were able to drift apart — one path got
 * fixed, three kept writing uncapped totals. One writer, one rule.
 */
export async function writeDailySnapshot(workerId, statDate, counters = {}, opts = {}) {
  const { extraCapMs = NaN, dbg = 'unknown' } = opts;
  const idle = capIdleSeconds(counters.idle_seconds, extraCapMs);
  const talk = Math.max(0, Math.round(Number(counters.talk_seconds) || 0));
  const calls = Math.max(0, Math.round(Number(counters.calls) || 0));
  const date = typeof statDate === 'string' ? statDate : istDateStr(new Date(statDate || Date.now()));

  try {
    await db._pool.query(
      `INSERT INTO fro_daily_stats (worker_id, stat_date, talk_seconds, calls, idle_seconds, updated_at)
       VALUES ($1, $2::date, $3, $4, $5, now())
       ON CONFLICT (worker_id, stat_date) DO UPDATE SET
         talk_seconds = GREATEST(fro_daily_stats.talk_seconds, EXCLUDED.talk_seconds),
         calls        = GREATEST(fro_daily_stats.calls,        EXCLUDED.calls),
         idle_seconds = GREATEST(fro_daily_stats.idle_seconds, EXCLUDED.idle_seconds),
         updated_at   = now()`,
      [workerId, date, talk, calls, idle]
    );
  } catch (e) {
    // Non-fatal: fro_daily_stats may be absent until migration 126, and the
    // monthly figure is not worth failing a status update for. Say so loudly,
    // because a silent failure here is how a multi-day total stayed hidden in
    // the live row until it finally surfaced as one impossible day.
    console.warn(`[froCounterDay] daily snapshot failed (${dbg}):`, e?.message || String(e));
  }
  return { idle, talk, calls, date };
}

/**
 * Bank a live row's counters against the day they actually belong to, and hand
 * back a zeroed set for today.
 *
 * Returns `{ rolled, statsDate, counters }` where `counters` is what the caller
 * should treat as the live row's counters from now on. When nothing rolled, the
 * caller's existing values pass through untouched.
 *
 * The old day's numbers are snapshotted, not thrown away: they are real shift
 * time and the monthly salary figure sums them.
 */
export async function rollCountersForNewDay(workerId, row, nowMs = Date.now(), opts = {}) {
  const today = istDateStr(new Date(nowMs));
  if (!isCounterDayStale(row, nowMs)) {
    return {
      rolled: false,
      statsDate: today,
      counters: Object.fromEntries(COUNTER_COLUMNS.map((c) => [c, row?.[c] ?? 0])),
    };
  }

  const priorDay = counterDayOf(row);
  // Bank what the row held for its own day, then start today clean. Idle comes
  // from the authoritative ledger for that date; talk/calls still come from the
  // live row until those are ledgered too. A pre-migration ledger yields null,
  // which banks zero idle rather than inventing it.
  const priorIdle = (await ledgerIdleForDate(workerId, priorDay, opts.shift)) ?? 0;
  await writeDailySnapshot(
    workerId,
    priorDay,
    {
      idle_seconds: priorIdle,
      talk_seconds: row?.today_talk_seconds || 0,
      calls: row?.today_calls || 0,
    },
    { dbg: 'roll-prior-day' }
  );

  return {
    rolled: true,
    priorDay,
    statsDate: today,
    counters: Object.fromEntries(COUNTER_COLUMNS.map((c) => [c, 0])),
  };
}

/**
 * Rollover plus a fresh idle total in one call, for the paths that write a live
 * status row and then snapshot it.
 *
 * Order matters. The rollover has to happen BEFORE the idle total is computed,
 * otherwise liveIdleSeconds() adds today's open period on top of yesterday's
 * committed counter and the inflated number is what gets written.
 *
 * `extraCapMs` is the caller's shift-window cap, forwarded to the snapshot.
 */
export async function prepareCountersForWrite(workerId, row, shift, nowMs = Date.now(), opts = {}) {
  const roll = await rollCountersForNewDay(workerId, row, nowMs, opts);

  // After a rollover the committed part of the live row is zero, so the total is
  // just whatever period is open now. Before one it is the row's own value plus
  // the open period, which is exactly what liveIdleSeconds already does.
  const base = roll.rolled
    ? { ...row, disposition_due_at: null }
    : row;
  const totalIdle = 0;

  return {
    rolled: roll.rolled,
    priorDay: roll.priorDay,
    statsDate: roll.statsDate,
    totalIdle,
    openPeriod: Number.isFinite(idlePeriodStartMs(base, nowMs)),
  };
}

/** The worker's own shift length in ms, for use as extraCapMs. NaN when unknown. */
export async function shiftWindowCapMs(workerId, nowMs = Date.now()) {
  try {
    const shift = await getShiftWindowMs(workerId, nowMs);
    if (Number.isFinite(shift?.startMs) && Number.isFinite(shift?.endMs) && shift.endMs > shift.startMs) {
      return shift.endMs - shift.startMs;
    }
  } catch (_) {
    // attendance/settings unreadable — the 24h invariant still applies.
  }
  return NaN;
}
