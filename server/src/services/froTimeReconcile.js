// froTimeReconcile — the server-authoritative WORKING -> IDLE transition.
//
// WHY THIS EXISTS
// ---------------
// The event system deliberately has no client event for "your 4-minute window
// expired". A worker who has walked away from the desk cannot be trusted, or
// expected, to send one — that was the flaw in activity-driven idling. Instead
// the server reconciles the ledger lazily: whenever a meaningful request arrives
// after the persisted disposition deadline, a worker still in WORKING is moved
// to IDLE.
//
// The transition is RETROSPECTIVE — the IDLE interval starts at the deadline,
// not at the request — so the seconds between the deadline and the next request
// are billed as idle exactly as if a heartbeat had been running. That is what
// lets the polling heartbeat be removed later: the stored deadline plus the next
// interaction are enough to reconstruct the truth.
//
// This module is the bridge between the live row (which owns the deadline) and
// the interval ledger (which owns the state). It never computes idle seconds;
// sumIntervalsByState does that from the intervals it writes.
import { TIME_STATES, isHeldState } from '../utils/froTimeState.js';
import { withinShift, dispositionDueMs } from '../utils/froIdle.js';
import { getOpenSession, transition } from './froTimeSessions.js';

/**
 * Pure decision. Returns `{ atMs }` when a WORKING worker should be moved to
 * IDLE because the disposition deadline has passed, else `null`.
 *
 * Excluded on purpose:
 *   - any state other than WORKING (IDLE is already idle; held and off-shift are
 *     not the worker's fault),
 *   - an admin pause or a company meeting (approved holds),
 *   - outside the shift window (idle is a shift-time state).
 *
 * `openStartedAtMs` is the start of the currently-open WORKING interval. The
 * idle start is clamped to it so a skewed deadline cannot invent an interval
 * that begins before the state it is leaving.
 */
export function dispositionIdlePlan({
  currentState,
  liveRow,
  shift,
  nowMs = Date.now(),
  openStartedAtMs = NaN,
} = {}) {
  if (currentState !== TIME_STATES.WORKING) return null;
  if (isHeldState(currentState)) return null; // defensive: WORKING is never held
  if (liveRow?.is_paused) return null;
  if (liveRow?.status === 'meeting') return null;
  if (!withinShift(shift, nowMs)) return null;

  const dueMs = dispositionDueMs(liveRow);
  if (!Number.isFinite(dueMs) || nowMs < dueMs) return null;

  const startMs = Number.isFinite(openStartedAtMs) ? openStartedAtMs : dueMs;
  return { atMs: Math.max(dueMs, startMs) };
}

/**
 * Reconcile one worker's ledger against the passed live row.
 *
 * Idempotent and non-fatal: when the ledger has no open interval (migration not
 * applied, or nobody has heartbeated yet) it returns without writing and lets
 * the legacy path own idle until the ledger is seeded.
 *
 * The actual write is a compare-and-set on WORKING, so a MEETING/PAUSE that
 * landed between the read and the write is never overwritten.
 */
export async function reconcileDispositionIdle({
  workerId,
  liveRow,
  shift,
  nowMs = Date.now(),
  pool = null,
} = {}) {
  if (!workerId) return { changed: false };

  let open;
  try {
    open = await getOpenSession(workerId, pool ? { pool } : {});
  } catch (_) {
    // Ledger absent (migration 171 not applied). The legacy heartbeat still
    // owns the IDLE transition, so this is a no-op rather than an error.
    return { changed: false, ledgerUnavailable: true };
  }
  if (!open) return { changed: false };

  const plan = dispositionIdlePlan({
    currentState: open.state,
    liveRow,
    shift,
    nowMs,
    openStartedAtMs: new Date(open.started_at).getTime(),
  });
  if (!plan) return { changed: false };

  try {
    const res = await transition(workerId, TIME_STATES.IDLE, {
      atMs: plan.atMs,
      reason: 'disposition_timeout',
      fromState: TIME_STATES.WORKING,
      ...(pool ? { pool } : {}),
    });
    return { changed: !!res.changed, idleSinceMs: plan.atMs };
  } catch (_) {
    return { changed: false };
  }
}
