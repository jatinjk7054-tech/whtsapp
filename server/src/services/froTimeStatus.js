// froTimeStatus — assembles the read model for the FRO time state machine.
//
// This is the bridge between the authoritative interval ledger
// (fro_time_sessions) and the response shapes every screen consumes. It exists
// so the status endpoint, the heartbeat response and any future reader compute
// worked/idle totals in ONE place. Two readers cannot disagree about the same
// worker because there is no second computation to disagree with.
//
// COMPATIBILITY (migration decision Q2)
// -------------------------------------
// During the migration the legacy fields (today_idle_seconds, is_idle,
// idle_since, idle_minutes, idle_seconds_total) are still returned, but they are
// DERIVED from the new authoritative state — never from a second, independent
// idle calculation. If the ledger has no rows for the day yet (a worker whose
// panel predates the roll-out), the totals fall back to a synthetic interval
// reconstructed from the live row's legacy state, so nothing reads as a
// surprise zero.
import { withinShift, isIdleNow, idlePeriodStartMs, dispositionDueMs } from '../utils/froIdle.js';
import { TIME_STATES, sumIntervalsByState } from '../utils/froTimeState.js';
import { getSessionsForDay } from './froTimeSessions.js';

function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * The state the legacy live row currently implies, used only until the ledger
 * has its own answer. Held states win, then off-shift, then idle, else working.
 */
export function legacyStateOf(liveRow, shift, nowMs = Date.now()) {
  if (liveRow?.is_paused) return TIME_STATES.PAUSED;
  if (liveRow?.status === 'meeting') return TIME_STATES.MEETING;
  if (!withinShift(shift, nowMs)) return TIME_STATES.OFF_SHIFT;
  if (isIdleNow(liveRow, shift, nowMs)) return TIME_STATES.IDLE;
  return TIME_STATES.WORKING;
}

/**
 * Reconstruct a plausible interval list for today from the legacy live row.
 * Used only when the ledger is empty for this worker (pre-migration panels).
 */
export function fallbackIntervals(liveRow, shift, nowMs = Date.now()) {
  const state = legacyStateOf(liveRow, shift, nowMs);
  const shiftStart = Number.isFinite(shift?.startMs) ? shift.startMs : nowMs;

  if (state === TIME_STATES.IDLE) {
    const idleStart = idlePeriodStartMs(liveRow, nowMs);
    const from = Number.isFinite(idleStart) ? idleStart : (dispositionDueMs(liveRow) || nowMs);
    const out = [];
    if (from > shiftStart) {
      out.push({ state: TIME_STATES.WORKING, started_at: toIso(shiftStart), ended_at: toIso(from) });
    }
    out.push({ state: TIME_STATES.IDLE, started_at: toIso(from), ended_at: null });
    return out;
  }

  return [{ state, started_at: toIso(shiftStart), ended_at: null }];
}

/**
 * The read model for one worker.
 *
 * Returns:
 *   state                 current authoritative state
 *   totals                per-state + worked/idle seconds for the IST day
 *   legacyIdleSince       start of the open IDLE interval, else null
 *   hasLedger             whether authoritative intervals exist for today
 */
export async function computeTimeStatus({ workerId, liveRow, shift, nowMs = Date.now(), pool } = {}) {
  let sessions = [];
  try {
    sessions = await getSessionsForDay(workerId, { nowMs, ...(pool ? { pool } : {}) });
  } catch (_) {
    // Ledger absent (migration not applied) → fall back to legacy derivation.
    sessions = [];
  }

  const hasLedger = sessions.length > 0;
  const intervals = hasLedger ? sessions : fallbackIntervals(liveRow, shift, nowMs);
  const totals = sumIntervalsByState(intervals, { shift, nowMs });

  const open = hasLedger ? sessions.find((s) => !s.ended_at) : null;
  const state = open?.state || legacyStateOf(liveRow, shift, nowMs);
  const legacyIdleSince = state === TIME_STATES.IDLE
    ? (open?.started_at || toIso(idlePeriodStartMs(liveRow, nowMs) || nowMs))
    : null;

  return { state, totals, legacyIdleSince, hasLedger, inShift: withinShift(shift, nowMs) };
}

/**
 * Build the response fields shared by /status/me and the heartbeat response.
 * New authoritative fields first, then the derived legacy compatibility fields.
 */
export function toStatusPayload(status) {
  const { state, totals, legacyIdleSince, inShift } = status;
  return {
    time_state: state,
    worked_seconds_today: totals.worked_seconds,
    idle_seconds_today: totals.idle_seconds,
    meeting_seconds_today: totals.meeting_seconds,
    pause_seconds_today: totals.pause_seconds,
    internet_problem_seconds_today: totals.internet_problem_seconds,
    off_shift_seconds_today: totals.off_shift_seconds,
    in_shift: inShift,
    // ── Legacy compatibility (Q2): derived, never an independent calculation ──
    today_idle_seconds: totals.idle_seconds,
    idle_seconds_total: totals.idle_seconds,
    idle_minutes: Math.floor(totals.idle_seconds / 60),
    is_idle: state === TIME_STATES.IDLE,
    idle_since: legacyIdleSince,
  };
}
