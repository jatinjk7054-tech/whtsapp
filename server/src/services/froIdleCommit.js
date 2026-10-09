import db from '../config/db.js';
import {
  getShiftWindowMs, liveIdleSeconds, idlePeriodStartMs, istDateStr,
  withinShift, dispositionDueMs,
} from '../utils/froIdle.js';
import { isCoveredAway } from './froCoverFreeze.js';
import { rollCountersForNewDay, writeDailySnapshot, isCounterDayStale, ledgerIdleForDate } from './froCounterDay.js';
import { closeOpenSession, getOpenSession } from './froTimeSessions.js';
import { isHeldState } from '../utils/froTimeState.js';

// Committing idle when an FRO session ENDS (manual sign-out or the shift-end
// auto-logout sweep).
//
// Why this exists: while someone is sitting idle, today_idle_seconds holds only
// COMMITTED time and the running stretch lives in idle_since. Every read adds
// them together, so the numbers on screen are always right — but the *stored*
// day total, and therefore the fro_daily_stats row the monthly salary total
// sums, only ever sees the last value a heartbeat happened to write. If a
// session ends while a period is still open, that tail is missing from the
// monthly figure. Both exit paths call this so nothing is lost.
//
// capMs optionally clamps the open period to a known shift end, so the
// auto-logout sweep (which fires shift-end + grace) cannot credit idle for the
// grace minutes after the officer had already gone home.

// Stamping idle the moment the disposition window lapses.
//
// today_idle_seconds only ever holds COMMITTED time, and the running stretch
// lives in idle_since — which is only written by a status push. There is no
// heartbeat, so an FRO who lets the window lapse and then leaves the app
// untouched keeps a row with a lapsed deadline and idle_since = NULL. Reads
// recover the stretch from the deadline, so the number on screen is right, but
// the STORED total stays at whatever it was (often 0). Anything reading the
// stored column — the NGO-admin board, fro_daily_stats, the monthly salary
// total — then disagrees with the strip by however long the officer sat there.
//
// This closes that gap by writing the stamp at the moment the deadline passes,
// so the row's own arithmetic matches the derived one. It is deliberately
// idempotent and never double counts: idle_since is set to the deadline, which
// is exactly where idlePeriodStartMs already begins counting, so a later commit
// banks the identical span.
export async function stampLapsedIdle(workerId, nowMs = Date.now()) {
  const id = String(workerId);
  if (!id) return false;

  // A covered-away FRO must not accrue idle. Someone else is working their
  // stations, so the fact that their row stopped refreshing says nothing about
  // whether they were sitting idle — and the disposition deadline left behind
  // would otherwise be backdated to whenever it lapsed, inventing hours of idle
  // for someone who was never at the desk.
  //
  // Only the away case is frozen. If the covered FRO is themselves refreshing
  // their own row right now, they are genuinely present and accrues normally.
  if (await isCoveredAway(id, nowMs)) return false;

  let row = null;
  try {
    const { rows } = await db._pool.query(
      `SELECT today_idle_seconds, idle_since, disposition_due_at, is_paused, status, stats_date
         FROM fro_live_status
        WHERE worker_id = $1
        LIMIT 1`,
      [id]
    );
    row = rows && rows[0] ? rows[0] : null;
  } catch (e) {
    console.warn('[froIdleCommit] live row read failed:', e?.message || String(e));
    return false;
  }
  if (!row) return false;

  // Already stamped — a real open period, so nothing to reconcile.
  if (row.idle_since) return false;
  // Admin-held rows are not the FRO sitting idle.
  if (row.is_paused || row.status === 'meeting') return false;

  // Held states freeze the disposition clock. A lapsed deadline that falls inside
  // an approved MEETING / PAUSE / INTERNET_PROBLEM must not be stamped as idle —
  // the ledger owns the authoritative held state. Absent a ledger, fall through to
  // the legacy behaviour so a pre-migration panel is unaffected.
  try {
    const open = await getOpenSession(id);
    if (open && isHeldState(open.state)) return false;
  } catch (_) { /* no ledger → legacy behaviour */ }

  const due = dispositionDueMs(row);
  if (!Number.isFinite(due) || nowMs < due) return false;
  // A deadline from a previous IST day is stale, not an open period today.
  if (istDateStr(new Date(due)) !== istDateStr(new Date(nowMs))) return false;
  // A row whose COUNTERS belong to a previous day is likewise not a row we should
  // be back-dating today's deadline into: idle_since is set to disposition_due_at,
  // so stamping it while the counters still describe another day is how a stale
  // total and a fresh period get welded into one figure.
  if (isCounterDayStale(row, nowMs)) return false;

  try {
    const shift = await getShiftWindowMs(id, nowMs);
    if (!withinShift(shift, nowMs)) return false;
  } catch (_) {
    return false;
  }

  try {
    await db._pool.query(
      `UPDATE fro_live_status
          SET idle_since = disposition_due_at,
              stats_date = $2::date,
              status = 'idle',
              updated_at = now()
        WHERE worker_id = $1
          AND idle_since IS NULL`,
      [id, istDateStr(new Date(nowMs))]
    );
    return true;
  } catch (e) {
    console.warn('[froIdleCommit] idle stamp failed:', e?.message || String(e));
    return false;
  }
}

export async function commitIdleOnExit(workerId, nowMs = Date.now(), capMs = null) {
  const id = String(workerId);
  if (!id) return null;

  let row = null;
  try {
    const { rows } = await db._pool.query(
      `SELECT today_idle_seconds, idle_since, disposition_due_at, is_paused, status,
              today_calls, today_talk_seconds, stats_date, frozen_at
         FROM fro_live_status
        WHERE worker_id = $1
        LIMIT 1`,
      [id]
    );
    row = rows && rows[0] ? rows[0] : null;
  } catch (e) {
    console.warn('[froIdleCommit] live row read failed:', e?.message || String(e));
    return null;
  }
  if (!row) return null;

  // Do not bank an open period for a covered-away FRO: the tail belongs to
  // someone else now, and this is the other half of the phantom-idle guard in
  // stampLapsedIdle(). Their own already-committed total is left untouched, so
  // nothing they genuinely sat through is lost.
  if (await isCoveredAway(id, nowMs)) return null;

  // Rollover BEFORE the total is computed. A sign-out is the single most likely
  // moment for a stale counter to be written back: the row is read, the day's
  // total is derived from it and written to the ledger with GREATEST. If the row
  // still held yesterday's committed idle — which it did whenever the worker ended
  // the previous day with idle_since = NULL, because the old reset was gated on
  // that — then today's ledger row inherited the whole running total. That is the
  // 52h19m figure.
  const roll = await rollCountersForNewDay(id, row, nowMs, { dbg: 'exit' });
  const base = roll.rolled
    ? { ...row, today_idle_seconds: 0, idle_since: null, disposition_due_at: null }
    : row;

  let endMs = nowMs;
  if (Number.isFinite(capMs)) endMs = Math.min(nowMs, capMs);
  else {
    // No caller-supplied cap: still clamp to the officer's real shift so a
    // sign-out hours after hours end cannot bill idle against tomorrow.
    try {
      const shift = await getShiftWindowMs(id, nowMs);
      if (Number.isFinite(shift?.endMs)) endMs = Math.min(nowMs, shift.endMs);
    } catch (_) {
      // Attendance unreadable — fall back to "up to now".
    }
  }

  // Finalize the authoritative interval ledger too. The open WORKING/IDLE
  // interval must not stay open after the worker has left, or it leaks across
  // midnight and inflates worked/idle on every later day. Clamped to the same
  // endMs as the live-row total, so post-shift minutes are never billed. Never
  // deletes: historical rows keep their duration.
  try {
    await closeOpenSession(id, { atMs: endMs, reason: 'exit' });
  } catch (e) {
    console.warn('[froIdleCommit] ledger close on exit failed:', e?.message || String(e));
  }

  // startMs -Infinity keeps the clamp off the shift START, so a period that began
  // before the window still banks the part that fell inside it.
  const total = liveIdleSeconds(base, { startMs: -Infinity, endMs }, nowMs);
  const calls = roll.rolled ? 0 : Number(base.today_calls || 0);
  const talk = roll.rolled ? 0 : Number(base.today_talk_seconds || 0);
  const hadOpen = Number.isFinite(idlePeriodStartMs(base, nowMs));

  try {
    // disposition_due_at is cleared too: with it still in the past, the
    // deadline-derived fallback in liveIdleSeconds would re-open a period that
    // we just banked and count the same seconds a second time.
    //
    // stats_date is stamped on every write. A row without it cannot be rolled, and
    // an un-stamped row is precisely the state that let a counter run for days.
    await db._pool.query(
      `UPDATE fro_live_status
          SET today_idle_seconds = $2::int,
              stats_date = $3::date,
              idle_since = NULL,
              disposition_due_at = NULL,
              updated_at = now()
        WHERE worker_id = $1`,
      [id, Math.max(0, Math.round(total)), roll.statsDate]
    );
  } catch (e) {
    console.warn('[froIdleCommit] live row update failed:', e?.message || String(e));
  }

  // Daily snapshot so the monthly salary total includes the tail, and so the
  // previous day keeps the total it actually earned rather than having it
  // overwritten by today's. Routed through the shared writer for the 24h cap.
  // Idle is authoritative from the ledger (the open interval is already clipped
  // at now by sumIntervalsByState); `total` is the pre-migration fallback.
  const ledgerIdle = await ledgerIdleForDate(id, roll.statsDate);
  await writeDailySnapshot(id, roll.statsDate, {
    idle_seconds: ledgerIdle != null ? ledgerIdle : total,
    talk_seconds: talk,
    calls,
  }, { dbg: 'exit' });

  return { total: Math.max(0, Math.round(total)), hadOpen, calls, talk, rolled: roll.rolled };
}
