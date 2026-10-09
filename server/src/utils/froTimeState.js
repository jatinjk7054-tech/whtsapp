// froTimeState — the pure, dependency-free core of the FRO server-authoritative
// time state machine.
//
// WHY THIS MODULE IS PURE. The previous idle engine mixed DB reads, client
// heuristics and arithmetic in the same functions, so the only way to test "is
// this FRO idle at time T" was to stand up a database and hope. The rule this
// rebuild is built on — every second of the shift is exactly one of WORKING,
// MEETING, PAUSED, INTERNET_PROBLEM, IDLE, SLEEPING, HIDDEN or OFF_SHIFT, and
// WORKED ∩ IDLE = ∅ — is arithmetic. It lives here with no imports so it can be
// unit-tested exhaustively.
//
// THE CONTRACT
// ------------
//   WORKED seconds = WORKING + MEETING + PAUSED + INTERNET_PROBLEM
//   IDLE seconds   = IDLE + SLEEPING + HIDDEN
//   OFF_SHIFT      = neither (time outside the shift window)
//
// MEETING, PAUSE and INTERNET_PROBLEM are held states: the worker is not
// producing but is also not being billed as idle — an approved hold overrides a
// hidden/sleep state. SLEEPING/HIDDEN are only idle when nothing approved
// overrides them.
//
// The disposition timer is paused by MEETING / PAUSED / INTERNET_PROBLEM and
// OFF_SHIFT, and is reset ONLY by a successful, backend-confirmed disposition.
// Mouse/keyboard/click/scroll/tab activity NEVER resets it — there is no
// activity input to this module at all. That is deliberate: activity-based
// resets were the bug class this rebuild removes.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const TIME_STATES = Object.freeze({
  WORKING: 'WORKING',
  IDLE: 'IDLE',
  MEETING: 'MEETING',
  PAUSED: 'PAUSED',
  INTERNET_PROBLEM: 'INTERNET_PROBLEM',
  SLEEPING: 'SLEEPING',
  HIDDEN: 'HIDDEN',
  OFF_SHIFT: 'OFF_SHIFT',
});

export const ALL_TIME_STATES = Object.freeze(Object.values(TIME_STATES));

// States that count toward worked_seconds_today.
export const WORKED_STATES = Object.freeze([
  TIME_STATES.WORKING,
  TIME_STATES.MEETING,
  TIME_STATES.PAUSED,
  TIME_STATES.INTERNET_PROBLEM,
]);

// States that count toward idle_seconds_today.
export const IDLE_STATES = Object.freeze([
  TIME_STATES.IDLE,
  TIME_STATES.SLEEPING,
  TIME_STATES.HIDDEN,
]);

// States that hold (pause) the disposition countdown. An approved held state
// overrides a page-hidden/sleep state — see resolveEventState.
export const HELD_STATES = Object.freeze([
  TIME_STATES.MEETING,
  TIME_STATES.PAUSED,
  TIME_STATES.INTERNET_PROBLEM,
]);

const WORKED_SET = new Set(WORKED_STATES);
const IDLE_SET = new Set(IDLE_STATES);
const HELD_SET = new Set(HELD_STATES);

export function isWorkedState(state) {
  return WORKED_SET.has(state);
}

export function isIdleState(state) {
  return IDLE_SET.has(state);
}

export function isHeldState(state) {
  return HELD_SET.has(state);
}

export function isKnownState(state) {
  return ALL_TIME_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// IST day math
// ---------------------------------------------------------------------------

export function istDateStr(date = new Date()) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

function istMidnightMs(dateStr) {
  return new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
}

/**
 * The IST calendar day [startMs, endMs) containing `nowMs`. All "today" totals
 * are measured against this window so a cross-midnight session cannot leak
 * yesterday's seconds into today's aggregate.
 */
export function istDayBoundsMs(nowMs = Date.now()) {
  const day = istDateStr(new Date(nowMs));
  const startMs = istMidnightMs(day);
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000, day };
}

// ---------------------------------------------------------------------------
// Interval math
// ---------------------------------------------------------------------------

/**
 * Milliseconds of overlap between [aStart,aEnd) and [bStart,bEnd). Returns 0 for
 * a degenerate/invalid interval. All bounds are epoch ms; +Infinity is allowed
 * for an open end.
 */
export function overlapMs(aStart, aEnd, bStart, bEnd) {
  const lo = Math.max(aStart, bStart);
  const hi = Math.min(aEnd, bEnd);
  return hi > lo ? hi - lo : 0;
}

/**
 * Clip an interval to the shift window and the IST day, then convert to whole
 * seconds. This is the single place "time that counts today" is defined.
 */
export function countableSeconds({
  startMs,
  endMs,
  shift = null,
  nowMs = Date.now(),
  dayBounds = null,
}) {
  const day = dayBounds || istDayBoundsMs(nowMs);
  const hi = Math.min(
    Number.isFinite(endMs) ? endMs : nowMs,
    nowMs,
    day.endMs,
    Number.isFinite(shift?.endMs) ? shift.endMs : Infinity
  );
  const lo = Math.max(
    startMs,
    day.startMs,
    Number.isFinite(shift?.startMs) ? shift.startMs : -Infinity
  );
  return hi > lo ? Math.round((hi - lo) / 1000) : 0;
}

/**
 * Sum seconds per state for the IST day, from a list of authoritative intervals.
 *
 * Each interval is { state, started_at, ended_at }. Open intervals are clipped
 * at `nowMs`. Everything is clipped to the shift window when supplied, so idle
 * accrued after hours is not displayed as shift-time idle.
 *
 * Returns an object keyed by state plus `worked_seconds`, `idle_seconds`,
 * `off_shift_seconds`. CALLERS MUST USE THESE DERIVED TOTALS — do not add a
 * second idle computation anywhere.
 */
export function sumIntervalsByState(intervals = [], { shift = null, nowMs = Date.now(), dayBounds = null } = {}) {
  const day = dayBounds || istDayBoundsMs(nowMs);
  const perState = Object.fromEntries(ALL_TIME_STATES.map((s) => [s, 0]));

  for (const it of intervals) {
    if (!it || !isKnownState(it.state)) continue;
    const startMs = new Date(it.started_at).getTime();
    if (!Number.isFinite(startMs)) continue;
    const endMs = it.ended_at ? new Date(it.ended_at).getTime() : Infinity;
    if (!Number.isFinite(endMs) && endMs !== Infinity) continue;
    // Skip intervals that do not touch the day at all.
    if (endMs <= day.startMs || startMs >= nowMs) continue;

    const secs = countableSeconds({ startMs, endMs, shift, nowMs, dayBounds: day });
    if (secs > 0) perState[it.state] += secs;
  }

  const workedSeconds = WORKED_STATES.reduce((acc, s) => acc + perState[s], 0);
  const idleSeconds = IDLE_STATES.reduce((acc, s) => acc + perState[s], 0);

  return {
    ...perState,
    worked_seconds: workedSeconds,
    idle_seconds: idleSeconds,
    meeting_seconds: perState[TIME_STATES.MEETING],
    pause_seconds: perState[TIME_STATES.PAUSED],
    internet_problem_seconds: perState[TIME_STATES.INTERNET_PROBLEM],
    sleep_hidden_seconds: perState[TIME_STATES.SLEEPING] + perState[TIME_STATES.HIDDEN],
    off_shift_seconds: perState[TIME_STATES.OFF_SHIFT],
    day_start_ms: day.startMs,
    day_end_ms: day.endMs,
  };
}

// ---------------------------------------------------------------------------
// Event -> next state
// ---------------------------------------------------------------------------

export const TIME_EVENTS = Object.freeze({
  DISPOSITION_SUCCESS: 'DISPOSITION_SUCCESS',
  MEETING_START: 'MEETING_START',
  MEETING_END: 'MEETING_END',
  PAUSE_START: 'PAUSE_START',
  PAUSE_END: 'PAUSE_END',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  NETWORK_ONLINE: 'NETWORK_ONLINE',
  CONNECTIVITY_FAILURE: 'CONNECTIVITY_FAILURE',
  CONNECTIVITY_RECOVERED: 'CONNECTIVITY_RECOVERED',
  PAGE_HIDDEN: 'PAGE_HIDDEN',
  PAGE_VISIBLE: 'PAGE_VISIBLE',
  SLEEP_START: 'SLEEP_START',
  SLEEP_END: 'SLEEP_END',
  SHIFT_START: 'SHIFT_START',
  SHIFT_END: 'SHIFT_END',
});

/**
 * Resolve the state an event moves the worker to.
 *
 * Precedence rules that matter:
 *   - An approved held state (MEETING / PAUSED / INTERNET_PROBLEM) is only left
 *     by its own end event. A PAGE_HIDDEN arriving mid-meeting must NOT drag the
 *     worker into HIDDEN — the meeting is the authoritative state.
 *   - SHIFT_END always wins: off the clock is off the clock.
 *   - Disposition success clears an IDLE state back to WORKING but never lifts a
 *     freeze the admin set.
 *
 * Returns the next state, or `null` when the event is not actionable from the
 * current state (caller should leave the open interval untouched).
 */
export function resolveEventState(currentState, event) {
  const cur = isKnownState(currentState) ? currentState : null;

  switch (event) {
    case TIME_EVENTS.SHIFT_END:
      return TIME_STATES.OFF_SHIFT;
    case TIME_EVENTS.SHIFT_START:
      return cur === TIME_STATES.OFF_SHIFT ? TIME_STATES.WORKING : null;

    case TIME_EVENTS.MEETING_START:
      return TIME_STATES.MEETING;
    case TIME_EVENTS.PAUSE_START:
      return TIME_STATES.PAUSED;
    case TIME_EVENTS.NETWORK_OFFLINE:
    case TIME_EVENTS.CONNECTIVITY_FAILURE:
      return TIME_STATES.INTERNET_PROBLEM;

    case TIME_EVENTS.MEETING_END:
    case TIME_EVENTS.PAUSE_END:
    case TIME_EVENTS.NETWORK_ONLINE:
    case TIME_EVENTS.CONNECTIVITY_RECOVERED:
    case TIME_EVENTS.SLEEP_END:
      // A held state is only left by its own matching end. Leaving INTERNET_PROBLEM
      // via a pause-end would be wrong; guard by only clearing when the current
      // state belongs to the same family, otherwise fall through to WORKING.
      if (event === TIME_EVENTS.MEETING_END && cur !== TIME_STATES.MEETING) return null;
      if (event === TIME_EVENTS.PAUSE_END && cur !== TIME_STATES.PAUSED) return null;
      if (
        (event === TIME_EVENTS.NETWORK_ONLINE || event === TIME_EVENTS.CONNECTIVITY_RECOVERED)
        && cur !== TIME_STATES.INTERNET_PROBLEM
      ) return null;
      return TIME_STATES.WORKING;

    case TIME_EVENTS.SLEEP_START:
      // Only sleep while actually working; an approved hold overrides sleep.
      return cur === TIME_STATES.WORKING || cur === TIME_STATES.IDLE
        ? TIME_STATES.SLEEPING
        : null;

    case TIME_EVENTS.PAGE_HIDDEN:
      // Same override rule as sleep: a meeting/pause/network hold is authoritative.
      return cur === TIME_STATES.WORKING || cur === TIME_STATES.IDLE
        ? TIME_STATES.HIDDEN
        : null;

    case TIME_EVENTS.PAGE_VISIBLE:
      return cur === TIME_STATES.HIDDEN || cur === TIME_STATES.SLEEPING
        ? TIME_STATES.WORKING
        : null;

    case TIME_EVENTS.DISPOSITION_SUCCESS:
      // A successful disposition proves the worker is at their desk. It clears
      // idle, but it must never punch through a freeze an admin set.
      if (HELD_SET.has(cur)) return null;
      return TIME_STATES.WORKING;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Disposition timer
// ---------------------------------------------------------------------------

export const DISPOSITION_WINDOW_SECONDS = 240;

/**
 * Whether the disposition countdown should currently be running. It does not
 * run outside the shift or while an approved hold is in effect.
 */
export function dispositionTimerRunning(timeState, { inShift = true } = {}) {
  if (!inShift) return false;
  return !HELD_SET.has(timeState) && timeState !== TIME_STATES.OFF_SHIFT;
}

export function secondsLeftFromDue(dueIso, nowMs = Date.now()) {
  if (!dueIso) return null;
  const due = new Date(dueIso).getTime();
  if (!Number.isFinite(due)) return null;
  return Math.max(0, Math.round((due - nowMs) / 1000));
}
