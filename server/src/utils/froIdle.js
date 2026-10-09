import db from '../config/db.js';
import { getOfficeStart, getOfficeEnd } from './attendanceStatus.js';
import { getSetting } from '../models/settingsModel.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The disposition deadline. Once armed, the FRO gets this long to record a
// disposition; recording one resets it. When it lapses the FRO is idle, and idle
// is cleared only by recording activity — the resume endpoint was removed
// because it made missing the window cost a button press instead of a
// disposition. The window is armed by the server itself: on the first heartbeat
// after the settle-in grace runs out (see SETTLE_SECONDS), and again by every
// successful disposition.
export const DISPOSITION_WINDOW_SECONDS = 240;

// How stale a live-status row may be before a read that has no other way to
// tell treats it as dead. Deliberately NOT used to decide whether idle counts:
// the open period is derived from the stored deadline, so a powered-off monitor
// or a crashed tab still accrues. This only gates presence checks.
export const IDLE_LIVE_FRESH_MS = 3 * 60 * 1000;

export function istDateStr(date = new Date()) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

function istTimeMs(dateStr, hour, minute) {
  return new Date(
    `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000+05:30`
  ).getTime();
}

function toMs(v) {
  if (!v) return NaN;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Which IST day do a live-status row's "today" counters belong to?
 *
 * fro_live_status is one row per worker carrying counters labelled "today", and
 * the day they describe is stamped in stats_date. That stamp is the only thing
 * that can answer it: the counters themselves are bare integers with no day of
 * their own, and idle_since / disposition_due_at are ruled out because
 * idlePeriodStartMs already guarantees a returned period start is on today.
 *
 * A row predating the stamp falls back to updated_at, the only evidence of which
 * day it was last written. With neither, the row cannot be claimed to belong to
 * a past day, so it is treated as current — the safe direction, since trusting
 * one stale row is recoverable and zeroing real idle for every existing worker
 * is not.
 *
 * Lives here rather than in froCounterDay because the READ paths need it too,
 * and this module is the one they all already import.
 */
export function counterDayOf(row) {
  if (!row) return null;
  if (row.stats_date) {
    return row.stats_date instanceof Date
      ? istDateStr(row.stats_date)
      : String(row.stats_date).slice(0, 10);
  }
  if (row.updated_at) return istDateStr(new Date(row.updated_at));
  return null;
}

/** True when the row's counters belong to a day before `nowMs`. */
export function isCounterDayStale(row, nowMs = Date.now()) {
  const day = counterDayOf(row);
  if (!day) return false;
  return day !== istDateStr(new Date(nowMs));
}

/**
 * The FRO's shift window as epoch ms. Attendance is the source of truth: a
 * punch-in anchors the start and a punch-out caps the end. With no attendance
 * row we fall back to the configured shift times (worker's own shift first,
 * then the office-wide setting) so the timer still behaves sensibly.
 *
 * Returns { startMs, endMs, hasAttendance }. startMs/endMs may be NaN when
 * nothing is resolvable — callers treat that as "no window, accrue nothing".
 */
export async function getShiftWindowMs(workerId, nowMs = Date.now()) {
  const day = istDateStr(new Date(nowMs));
  let punchIn = NaN;
  let punchOut = NaN;
  try {
    const { data } = await db
      .from('attendance')
      .select('punch_in_time, punch_out_time')
      .eq('worker_id', workerId)
      .not('punch_in_time', 'is', null)
      .order('punch_in_time', { ascending: false })
      .limit(1)
      .maybeSingle();
    punchIn = toMs(data?.punch_in_time);
    punchOut = toMs(data?.punch_out_time);
  } catch (_) {
    // attendance may be unreadable — fall through to the configured shift.
  }

  const [officeStart, officeEnd] = await Promise.all([getOfficeStart(workerId), getOfficeEnd(workerId)]);
  const cfgStart = istTimeMs(day, officeStart.hour, officeStart.minute);
  const cfgEnd = istTimeMs(day, officeEnd.hour, officeEnd.minute);

  const hasAttendance = Number.isFinite(punchIn);
  let startMs = hasAttendance ? punchIn : cfgStart;
  let endMs = Number.isFinite(punchOut) ? punchOut : cfgEnd;

  // A row written for an earlier day must not anchor today's window.
  if (hasAttendance && istDateStr(new Date(punchIn)) !== day) {
    startMs = cfgStart;
    if (Number.isFinite(punchOut) && istDateStr(new Date(punchOut)) === day) endMs = punchOut;
    else endMs = cfgEnd;
  }
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = cfgEnd > startMs ? cfgEnd : startMs;

  return { startMs, endMs, hasAttendance };
}

const parseHhMm = (v, fallbackHour, fallbackMinute) => {
  if (!v) return { hour: fallbackHour, minute: fallbackMinute };
  const [hour, minute] = String(v).split(':').map(Number);
  return { hour: hour || fallbackHour, minute: minute || 0 };
};

// Batched form of getShiftWindowMs.
//
// WHY THIS EXISTS. The NGO-admin dashboard builds a shift window for every FRO on
// the board, and did it with Promise.all(froWorkers.map(getShiftWindowMs)). Each
// single call issued up to FIVE queries: one attendance read, then getOfficeStart
// and getOfficeEnd EACH independently re-fetched the same worker row with
// select('*'), and each could fall through to a settings read. For a 50-FRO board
// that is ~250 round-trips against a pool capped at 5 connections, every time a
// browser tab polls (10s interval, one request per open tab). The queueing behind
// a 5-connection pool is what made /ngo-admin/tl-dashboard take ~16s, and that
// endpoint is the single largest CPU consumer on the host.
//
// This does the same arithmetic in JS from three queries total, and reads each
// worker row exactly once. Same fallback order as the single-worker version:
// punch_in_time wins when it is from today, otherwise the configured shift, and
// office hours are only consulted when the worker has no shift of their own.
//
// Returns { [workerId]: { startMs, endMs, hasAttendance } }. A worker that fails
// to resolve is simply absent from the map, which is what the previous
// try/catch-in-the-loop produced too (it left that FRO on the open-ended
// fallback), so callers keep the same "no entry" handling.
export async function getShiftWindowsMs(workerIds, nowMs = Date.now()) {
  const ids = [...new Set((workerIds || []).filter(Boolean))];
  const out = {};
  if (ids.length === 0) return out;

  const day = istDateStr(new Date(nowMs));

  // Latest punch per worker in one round trip.
  const punches = {};
  try {
    const { data } = await db
      .from('attendance')
      .select('worker_id, punch_in_time, punch_out_time')
      .in('worker_id', ids)
      .not('punch_in_time', 'is', null)
      .order('worker_id', { ascending: true })
      .order('punch_in_time', { ascending: false });
    // Ordered by worker then punch_in desc, so the first row per worker is the
    // newest punch. Later rows for the same worker are older days and are ignored.
    for (const r of data || []) {
      if (!punches[r.worker_id]) punches[r.worker_id] = r;
    }
  } catch (_) {
    // attendance unreadable — everyone falls back to the configured shift.
  }

  // Worker shift overrides, one row per worker (no select('*')).
  const shiftRows = {};
  try {
    const { data } = await db
      .from('workers')
      .select('id, shift_start_time, shift_end_time')
      .in('id', ids);
    for (const r of data || []) shiftRows[r.id] = r;
  } catch (_) {
    // fall through to org-wide office hours
  }

  // Org defaults are global, so at most two reads and they usually resolve from
  // the settings model's own cache.
  const needDefaultStart = Object.values(shiftRows).some((w) => !w?.shift_start_time);
  const needDefaultEnd = Object.values(shiftRows).some((w) => !w?.shift_end_time);
  let defStart = { hour: 10, minute: 0 };
  let defEnd = { hour: 19, minute: 0 };
  try {
    if (needDefaultStart) {
      const v = await getSetting('office_start_time');
      defStart = parseHhMm(v, 10, 0);
    }
    if (needDefaultEnd) {
      const v = await getSetting('office_end_time');
      defEnd = parseHhMm(v, 19, 0);
    }
  } catch (_) {
    // keep the hardcoded defaults
  }

  for (const id of ids) {
    const row = shiftRows[id];
    const start = parseHhMm(row?.shift_start_time, defStart.hour, defStart.minute);
    const end = parseHhMm(row?.shift_end_time, defEnd.hour, defEnd.minute);
    const cfgStart = istTimeMs(day, start.hour, start.minute);
    const cfgEnd = istTimeMs(day, end.hour, end.minute);

    const p = punches[id];
    const punchIn = toMs(p?.punch_in_time);
    const punchOut = toMs(p?.punch_out_time);
    const hasAttendance = Number.isFinite(punchIn);

    let startMs = hasAttendance ? punchIn : cfgStart;
    let endMs = Number.isFinite(punchOut) ? punchOut : cfgEnd;

    // A row written for an earlier day must not anchor today's window.
    if (hasAttendance && istDateStr(new Date(punchIn)) !== day) {
      startMs = cfgStart;
      endMs = Number.isFinite(punchOut) && istDateStr(new Date(punchOut)) === day ? punchOut : cfgEnd;
    }
    if (!Number.isFinite(endMs) || endMs <= startMs) endMs = cfgEnd > startMs ? cfgEnd : startMs;

    out[id] = { startMs, endMs, hasAttendance };
  }

  return out;
}

/**
 * Are we inside the FRO's shift? Idle only accrues between shift start and
 * shift end, and the disposition timer only runs inside that window too.
 */
export function withinShift(shift, nowMs = Date.now()) {
  return Number.isFinite(shift?.startMs) && nowMs >= shift.startMs && nowMs <= shift.endMs;
}

/**
 * Start of the currently-open idle period, in epoch ms, or NaN when there is
 * none.
 *
 * Normally that is idle_since, stamped the first time a heartbeat notices the
 * deadline lapsed. But if the FRO's machine is off/asleep/closed there is no
 * heartbeat to stamp it, and the running period would be invisible — the officer
 * could sit out the rest of the shift with the money never counted. So when the
 * deadline has passed and nothing has been stamped yet, the deadline itself IS
 * the start of the period. That makes the open period derivable at any moment
 * from stored state alone, with no client cooperation.
 *
 * Paused/meeting rows are exempt — the admin is holding them, not the FRO.
 */
export function idlePeriodStartMs(row, nowMs = Date.now()) {
  const today = istDateStr(new Date(nowMs));
  const stamped = toMs(row?.idle_since);
  let from = NaN;
  if (Number.isFinite(stamped)) {
    // A period left over from a previous IST day is stale, not "currently idle".
    // Clipping it into today would invent idle from the shift start onwards for
    // an officer who did nothing, so drop it outright — the committed total it
    // would have been added to belongs to yesterday anyway.
    if (istDateStr(new Date(stamped)) !== today) return NaN;
    from = stamped;
  } else {
    // No stamp yet: a deadline that has already passed means the period began
    // then, and is derivable with no client cooperation (monitor off, tab
    // closed, crash). Same IST-day rule applies.
    if (row?.is_paused || row?.status === 'meeting') return NaN;
    const due = toMs(row?.disposition_due_at);
    if (!Number.isFinite(due) || nowMs < due) return NaN;
    if (istDateStr(new Date(due)) !== today) return NaN;
    from = due;
  }
  return from;
}

/**
 * Idle seconds for a live-status row, counting the still-open period.
 *
 * today_idle_seconds only holds COMMITTED time; while the FRO sits idle the
 * current period lives in idle_since (or is derivable from a lapsed deadline)
 * and is added on read, clamped to the shift window. That way a closed tab, a
 * crash or a powered-off monitor cannot lose the time — the row keeps the open
 * period until someone commits it.
 */
export function liveIdleSeconds(row, shift, nowMs = Date.now(), frozenAtMs = NaN) {
  // Committed idle counts only on the day it was banked.
  //
  // The rollover that clears a day's counters lives on the WRITE paths, so a
  // worker who has not written to their row since yesterday evening still
  // carries yesterday's numbers. Reads have to notice that themselves, and the
  // one signal that says so is the row's stats_date.
  //
  // This used to be decided the other way round: the day was inferred from
  // idle_since / disposition_due_at, and only on the path where a period was
  // open — the committed-only early return below skipped the check entirely.
  // Since idlePeriodStartMs only ever yields a start on today's IST day, that
  // check could not have failed anyway, so yesterday's banked total was returned
  // verbatim by both paths. The first thing the office saw each morning was
  // yesterday's idle on every row nobody had logged into yet.
  const committed = isCounterDayStale(row, nowMs) ? 0 : (Number(row?.today_idle_seconds || 0) || 0);
  const from = idlePeriodStartMs(row, nowMs);
  if (!Number.isFinite(from)) return committed;
  const lo = Math.max(from, Number.isFinite(shift?.startMs) ? shift.startMs : -Infinity);
  // `frozenAtMs` caps accrual instead of nulling the period, so a frozen worker
  // keeps the idle they genuinely racked up before they left and banks nothing
  // after — see frozenIdleSeconds.
  //
  // A meeting or admin pause freezes the server's own countdown. When the row
  // carries frozen_at, an idle period that had already begun when the freeze
  // started stops accruing there, so the held stretch is work time, not idle.
  // The cap is keyed on the period's START rather than the row's current status,
  // so it also keeps capping after the freeze lifts, and is inert for a period
  // that only began later (its start is past frozen_at). Explicit frozenAtMs (the
  // covered-away caller) always wins.
  let cap = frozenAtMs;
  if (!Number.isFinite(cap)) {
    const frozenMs = toMs(row?.frozen_at);
    if (Number.isFinite(frozenMs) && from <= frozenMs) cap = frozenMs;
  }
  const hi = Math.min(
    nowMs,
    Number.isFinite(shift?.endMs) ? shift.endMs : nowMs,
    Number.isFinite(cap) ? cap : nowMs
  );
  return committed + (hi > lo ? Math.round((hi - lo) / 1000) : 0);
}

/**
 * The last instant we have EVIDENCE this worker was still at their desk: the
 * moment their own live row was last written.
 *
 * That is the honest freeze point for someone who is being covered and has gone
 * quiet. A quiet row means "not at the desk", and the last write is the last
 * moment that was untrue. Everything after it is time this person was not
 * present and must not be billed as idle.
 *
 * A row that does not exist at all has no evidence of presence whatsoever, so the
 * cutoff is 0 and only already-committed idle survives.
 */
export function idleFreezeCutoffMs(row) {
  const updatedAt = toMs(row?.updated_at);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

/**
 * Idle seconds for a covered-away worker: the open period stops accruing at the
 * last moment their own row was written.
 *
 * The commit guard in froIdleCommit already stops the total being WRITTEN, but
 * without this the read paths still counted the open period — an admin board, a
 * status list and the FRO's own strip each added the still-running minutes on top
 * of the committed total, so the number kept climbing for someone who had already
 * gone home. Clamping at read time is what makes "frozen" mean frozen everywhere,
 * not just in the ledger.
 */
export function frozenIdleSeconds(row, shift, nowMs = Date.now()) {
  return liveIdleSeconds(row, shift, nowMs, idleFreezeCutoffMs(row));
}

/**
 * Just the still-open idle period (no committed time), clamped to the shift.
 * This is what an admin needs for "how long has this person been sitting idle
 * right now" — distinct from the day total that includes earlier, banked
 * stretches. Returns 0 when there is no usable open period.
 */
export function openIdleSeconds(row, shift, nowMs = Date.now(), frozenAtMs = NaN) {
  const from = idlePeriodStartMs(row, nowMs);
  if (!Number.isFinite(from)) return 0;
  // A period left over from a previous IST day is stale, not "currently idle".
  if (istDateStr(new Date(from)) !== istDateStr(new Date(nowMs))) return 0;
  // Freeze cap: same rule as liveIdleSeconds — a period that began at or before
  // frozen_at stops accruing there, whether the row is still held or already
  // lifted. Explicit frozenAtMs (covered-away) always wins.
  let cap = frozenAtMs;
  if (!Number.isFinite(cap)) {
    const frozenMs = toMs(row?.frozen_at);
    if (Number.isFinite(frozenMs)) cap = frozenMs;
  }
  // Frozen and the period only began after the freeze point: nothing is accruing,
  // so the "how long have they been idle right now" answer is 0.
  if (Number.isFinite(cap) && from > cap) return 0;
  const lo = Math.max(from, Number.isFinite(shift?.startMs) ? shift.startMs : -Infinity);
  const hi = Math.min(
    nowMs,
    Number.isFinite(shift?.endMs) ? shift.endMs : nowMs,
    Number.isFinite(cap) ? cap : nowMs
  );
  return hi > lo ? Math.round((hi - lo) / 1000) : 0;
}

/**
 * THE idle figure every read path must use. One definition, so the super-admin
 * live list, the NGO-admin board, the FRO's own strip and the dashboard alerts
 * cannot disagree about the same FRO at the same moment.
 *
 * `shift` is optional. Pass it wherever the FRO's own working hours are known,
 * so idle accrued outside the shift is not displayed as working-time idle.
 */
export function effectiveIdleSeconds(row, shift = null, nowMs = Date.now(), frozenAtMs = NaN) {
  return liveIdleSeconds(row, shift, nowMs, frozenAtMs);
}

/**
 * Fold any open idle period into today_idle_seconds and clear idle_since.
 * Returns the committed total (or null when the row had nothing to commit, so
 * callers can skip a pointless write).
 */
export function commitIdle(row, shift, nowMs = Date.now()) {
  const total = liveIdleSeconds(row, shift, nowMs);
  if (!row?.idle_since) return null;
  return total;
}

/**
 * Has the disposition deadline lapsed? A lapsed deadline means the FRO is idle
 * regardless of what the client claims.
 */
export function deadlinePassed(row, nowMs = Date.now()) {
  const due = toMs(row?.disposition_due_at);
  return Number.isFinite(due) && nowMs >= due;
}

/** Deadline for "now + one full window", or null outside the shift. */
export function nextDeadline(shift, nowMs = Date.now()) {
  if (!withinShift(shift, nowMs)) return null;
  return new Date(nowMs + DISPOSITION_WINDOW_SECONDS * 1000).toISOString();
}

export function dispositionDueMs(row) {
  return toMs(row?.disposition_due_at);
}

/**
 * The one-time settle-in grace, in seconds, granted on first panel presence of
 * the IST day.
 *
 * WHY. The disposition window used to be opened by the FRO's first recorded
 * action, so signing in and sitting on the panel cost nothing at all: with no
 * deadline on the row there was no lapse for any reader to derive an idle
 * period from, and the FRO only started being billed once they had already done
 * the work. Three minutes to settle is now granted on login, and the ordinary
 * 4-minute window arms by itself the moment that grace runs out.
 *
 * This is a grace BEFORE the window, not a shorter window.
 * DISPOSITION_WINDOW_SECONDS is deliberately unchanged.
 */
export const SETTLE_SECONDS = 180;

/**
 * The row's settle-in deadline in epoch ms, but only when it is usable right
 * now: stamped on today's IST day.
 *
 * Staleness is judged by IST day rather than by clearing the column on rollover,
 * which is the same rule withoutStaleIdle already applies to idle_since. A
 * leftover from yesterday therefore reads as "no grace granted" without the write
 * paths having to know this column exists, which is what keeps a panel left open
 * across midnight from carrying yesterday's spent grace into today.
 */
export function settleUntilMs(row, nowMs = Date.now()) {
  const until = toMs(row?.settle_until);
  if (!Number.isFinite(until)) return NaN;
  if (istDateStr(new Date(until)) !== istDateStr(new Date(nowMs))) return NaN;
  return until;
}

/**
 * Seconds left on the settle-in grace, or null when there is none to show.
 *
 * Null rather than 0 is deliberate: 0 would be indistinguishable from a grace
 * that has just expired, and the two want different things on screen.
 */
export function settleSecondsLeft(row, nowMs = Date.now()) {
  const until = settleUntilMs(row, nowMs);
  if (!Number.isFinite(until)) return null;
  return Math.max(0, Math.round((until - nowMs) / 1000));
}

/**
 * Is this row in a state where the server may hand out clock time on its own?
 *
 * Both the settle grant and the window arm stand down for the same reasons, and
 * each one is a way this change would otherwise become a billing bug rather than
 * a fix:
 *
 *  - the shift is closed. There is no window to open, and idle accrues outside
 *    the shift regardless.
 *  - the FRO is held (meeting or admin pause). They are not at the desk, and the
 *    existing freeze logic already hands back a full window when it lifts.
 *    Arming during a freeze would start a countdown against a frozen row.
 *  - an idle period is already open, or a live deadline is already on the row.
 *    The first is an FRO being billed idle right now, who must not be quietly
 *    re-armed. The second already has a window, and re-arming would slide it
 *    forward on every heartbeat — exactly the "timer resets itself to 4:00"
 *    behaviour this change exists to close.
 */
function canStartWindow(row, shift, nowMs) {
  if (!withinShift(shift, nowMs)) return false;
  if (row?.is_paused || row?.status === 'meeting') return false;
  if (Number.isFinite(idlePeriodStartMs(row, nowMs))) return false;
  // A deadline from a previous IST day is a leftover, not a live window.
  // withoutStaleIdle normally clears it before this runs, so this only matters on
  // a path that skipped it — and it must not block a legitimate grant.
  const dueMs = dispositionDueMs(row);
  if (Number.isFinite(dueMs)
    && istDateStr(new Date(dueMs)) === istDateStr(new Date(nowMs))) return false;
  return true;
}

/**
 * Grant the one-time settle-in grace. Returns the ISO deadline to store, or null
 * when this heartbeat must not touch it.
 *
 * Once per IST day, not once per session: a session-scoped grace could be farmed
 * by closing and reopening the panel, which would relocate the original free hour
 * to a different key rather than close it.
 */
export function settleGrant(row, shift, nowMs = Date.now()) {
  if (!canStartWindow(row, shift, nowMs)) return null;
  // Already granted today, whether spent or still running. Never regrant.
  if (Number.isFinite(settleUntilMs(row, nowMs))) return null;
  return new Date(nowMs + SETTLE_SECONDS * 1000).toISOString();
}

/**
 * Arm the ordinary disposition window now that the grace has run out. Returns
 * the ISO deadline to store, or null when nothing should change.
 *
 * The deadline is measured from the grace's own expiry rather than from now, so a
 * heartbeat that lands late cannot shorten the window the FRO was promised. An
 * FRO who closes the panel during the grace and comes back an hour later is
 * therefore armed with a deadline that is already in the past and is billed from
 * it: reopening the panel buys no time.
 */
export function settleWindowArm(row, shift, nowMs = Date.now()) {
  if (!canStartWindow(row, shift, nowMs)) return null;
  const until = settleUntilMs(row, nowMs);
  // No grace on the row, or it has not run out yet.
  if (!Number.isFinite(until) || nowMs < until) return null;
  return new Date(until + DISPOSITION_WINDOW_SECONDS * 1000).toISOString();
}

/**
 * Drop idle state left over from a previous day, without writing to the
 * database.
 *
 * A row carries two kinds of stale value, and both make a worker look idle the
 * moment they sign in:
 *
 *  - an `idle_since` stamped on a previous IST day, and
 *  - a `disposition_due_at` stamped on a previous IST day, which is always in
 *    the past by the time they log back in.
 *
 * The heartbeat already discarded both, but only when it ran. The login
 * hydrate did not, so signing in reported `is_idle: true` off yesterday's row
 * and the panel flashed the Resume overlay until the first heartbeat corrected
 * it. Readers must apply the same rule, so the logic lives here once.
 *
 * `shift` is no longer part of the test on purpose — see the note on
 * `staleDeadline` below. It stays in the signature so existing callers do not
 * have to change.
 *
 * Returns a new object; the caller decides whether to persist.
 */
export function withoutStaleIdle(row, shift, nowMs = Date.now()) {
  if (!row) return row;
  const staleIdle = Number.isFinite(toMs(row.idle_since))
    && istDateStr(new Date(toMs(row.idle_since))) !== istDateStr(new Date(nowMs));
  const dueMs = toMs(row?.disposition_due_at);
  // "Stale" means a leftover from a previous day, full stop. It must NOT mean
  // "older than the shift start we just resolved": the shift window is read from
  // attendance with a configured-office-hours fallback, so it legitimately moves
  // between calls (a missing or late punch-in row changes it). Comparing the
  // deadline against that moving start used to null a window that was merely
  // EXPIRED, and the FRO's very next action then quietly re-armed a fresh 4
  // minutes — the "the timer reset itself to 4:00" report. Expiry is a question
  // about the clock, not about which window we happened to resolve this time.
  const staleDeadline = Number.isFinite(dueMs)
    && istDateStr(new Date(dueMs)) !== istDateStr(new Date(nowMs));
  if (!staleIdle && !staleDeadline) return row;
  return {
    ...row,
    ...(staleIdle ? { idle_since: null, today_idle_seconds: 0 } : {}),
    ...(staleDeadline ? { disposition_due_at: null } : {}),
  };
}

/**
 * Is this FRO idle right now? The single answer every reader must give.
 *
 * Deliberately requires the shift to be open. Idle is a shift-time state — the
 * seconds only count inside the window — so a row whose idle_since is still set
 * after hours has simply not been cleaned up yet, and reporting it as idle
 * parks a blocking Resume overlay on a worker who is off the clock.
 *
 * Delegates the "is a period open" half to idlePeriodStartMs so the same rule
 * decides this everywhere: a stamp from a previous IST day does not count, an
 * already-lapsed deadline does, and a paused or meeting FRO never does.
 */
export function isIdleNow(row, shift, nowMs = Date.now(), frozenAtMs = NaN) {
  if (!withinShift(shift, nowMs)) return false;
  if (row?.is_paused || row?.status === 'meeting') return false;
  const from = idlePeriodStartMs(row, nowMs);
  if (!Number.isFinite(from)) return false;
  // Frozen: an open period that began before the freeze point is real idle, but
  // one that only started after it is not. Without this a covered-away worker
  // whose deadline lapsed after they left would still show an Idle badge, and the
  // FRO's own panel would park a blocking Resume overlay on somebody who is
  // already covering somebody else.
  if (Number.isFinite(frozenAtMs) && from > frozenAtMs) return false;
  return true;
}

export function secondsLeft(row, nowMs = Date.now()) {
  const due = dispositionDueMs(row);
  if (!Number.isFinite(due)) return null;
  return Math.max(0, Math.round((due - nowMs) / 1000));
}
