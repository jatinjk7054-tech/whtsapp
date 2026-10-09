// froTimeSessions — the write/read layer for the authoritative interval ledger.
//
// This is the ONLY module that writes fro_time_sessions. Every state change in
// the app funnels through transition(), which:
//
//   1. locks the worker's open interval (so concurrent events serialize),
//   2. no-ops when the requested state is already open (idempotent),
//   3. closes the open interval, then opens the next one in one transaction.
//
// The database enforces the rest: at most one open interval per worker (partial
// unique index) and no overlapping intervals (exclusion constraint). If an
// invariant is ever about to be violated the insert fails loudly instead of
// silently double-counting seconds.
import db from '../config/db.js';
import {
  isKnownState,
  resolveEventState,
  sumIntervalsByState,
  istDayBoundsMs,
} from '../utils/froTimeState.js';

const OPEN_SESSION_UNIQUE = 'uq_fro_time_sessions_open_per_worker';

function toIso(ms) {
  return new Date(ms).toISOString();
}

function durationSecondsBetween(startMs, endMs) {
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

/**
 * Move a worker to `state`, closing the currently-open interval.
 *
 * Idempotent: replaying the same event (socket retry, double click, duplicate
 * disposition) while the target state is already open returns changed:false and
 * writes nothing.
 *
 * `atMs` is a SERVER timestamp. Callers must never pass a client Date.now().
 */
export async function transition(workerId, state, { atMs = Date.now(), reason = null, sessionId = null, pool = db._pool, fromState = null } = {}) {
  if (!workerId) throw new Error('transition: workerId is required');
  if (!isKnownState(state)) throw new Error(`transition: unknown time state "${state}"`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, session_id, state, started_at
         FROM fro_time_sessions
        WHERE worker_id = $1 AND ended_at IS NULL
        FOR UPDATE`,
      [workerId]
    );
    const open = rows[0];

    // Conditional transition (compare-and-set). A caller that decided to move
    // the worker based on a state it read OUTSIDE this lock passes fromState; if
    // a concurrent writer changed the open state in the meantime the write is
    // skipped instead of clobbering it. Used by deadline reconciliation so a
    // MEETING/PAUSE that landed between the read and the write is never
    // overwritten by a stale IDLE decision.
    if (fromState && (!open || open.state !== fromState)) {
      await client.query('COMMIT');
      return { changed: false, state, skipped: true };
    }

    if (open && open.state === state) {
      await client.query('COMMIT');
      return { changed: false, state, sessionId: open.session_id, id: open.id };
    }

    if (open) {
      const startedMs = new Date(open.started_at).getTime();
      const endMs = Math.max(atMs, startedMs);
      await client.query(
        `UPDATE fro_time_sessions
            SET ended_at = $2, duration_seconds = $3, updated_at = now()
          WHERE id = $1`,
        [open.id, toIso(endMs), durationSecondsBetween(startedMs, endMs)]
      );
    }

    const effectiveSessionId = sessionId || open?.session_id || null;
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO fro_time_sessions (worker_id, session_id, state, started_at, reason, updated_at)
         VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, now())
         RETURNING id, session_id`,
        [workerId, effectiveSessionId, state, toIso(atMs), reason]
      );
    } catch (insErr) {
      // Defensive: if a concurrent writer somehow opened a same-state interval
      // between our lock release and insert (it cannot with FOR UPDATE, but the
      // cost of being wrong is double-counted time), treat a unique violation as
      // "already in that state" rather than failing the caller's real work.
      if (insErr.code === '23505' && String(insErr.constraint || '').includes(OPEN_SESSION_UNIQUE)) {
        await client.query('ROLLBACK');
        return { changed: false, state };
      }
      throw insErr;
    }

    await client.query('COMMIT');
    return { changed: true, state, sessionId: inserted.rows[0].session_id, id: inserted.rows[0].id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply a named time event (MEETING_START, PAGE_HIDDEN, …) to a worker.
 *
 * The current state is read from the open interval. If the event is not
 * actionable from that state — e.g. a PAGE_HIDDEN arriving during a meeting — the
 * held state wins and nothing changes.
 */
export async function applyEvent(workerId, event, { atMs = Date.now(), reason = null, currentState = null, pool = db._pool } = {}) {
  const open = await getOpenSession(workerId, { pool });
  const cur = currentState || open?.state || null;
  const next = resolveEventState(cur, event);
  if (!next) return { changed: false, state: cur };
  return transition(workerId, next, { atMs, reason: reason || event, pool });
}

/** Close the worker's open interval without opening a new one. */
export async function closeOpenSession(workerId, { atMs = Date.now(), reason = null, pool = db._pool } = {}) {
  if (!workerId) return { changed: false };
  const { rowCount } = await pool.query(
    `UPDATE fro_time_sessions
        SET ended_at = $2,
            duration_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - started_at))))::int,
            reason = COALESCE($3, reason),
            updated_at = now()
      WHERE worker_id = $1 AND ended_at IS NULL`,
    [workerId, toIso(atMs), reason]
  );
  return { changed: rowCount > 0 };
}

/** The worker's currently-open interval, or null. */
export async function getOpenSession(workerId, { pool = db._pool } = {}) {
  const { rows } = await pool.query(
    `SELECT id, session_id, state, started_at, reason
       FROM fro_time_sessions
      WHERE worker_id = $1 AND ended_at IS NULL
      LIMIT 1`,
    [workerId]
  );
  return rows[0] || null;
}

/**
 * All intervals that touch the IST calendar day `dateStr` ('YYYY-MM-DD'), oldest
 * first. An interval that started the previous day but is still open
 * (cross-midnight shift) is included and clipped by sumIntervalsByState.
 */
export async function getSessionsForDate(workerId, dateStr, { pool = db._pool } = {}) {
  const startMs = new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return getSessionsInRange(workerId, startMs, endMs, { pool });
}

/**
 * All intervals that overlap the half-open window [fromMs, toMs), oldest first.
 *
 * An interval is included when it starts before the window ends and ends after
 * the window begins, so an interval that straddles `fromMs` — or is still open —
 * is returned and must be clipped by the caller (sumIntervalsByState, or the
 * per-IST-day splitter in froTimeReport). This is the read the historical idle
 * reports are built on.
 */
export async function getSessionsInRange(workerId, fromMs, toMs, { pool = db._pool } = {}) {
  const { rows } = await pool.query(
    `SELECT id, session_id, state, started_at, ended_at, duration_seconds, reason
       FROM fro_time_sessions
      WHERE worker_id = $1
        AND started_at < $3
        AND COALESCE(ended_at, 'infinity'::timestamptz) > $2
      ORDER BY started_at ASC`,
    [workerId, toIso(fromMs), toIso(toMs)]
  );
  return rows;
}

/** All intervals that touch the IST day containing `nowMs`, oldest first. */
export async function getSessionsForDay(workerId, { nowMs = Date.now(), pool = db._pool } = {}) {
  const day = istDayBoundsMs(nowMs);
  return getSessionsForDate(workerId, day.day, { pool });
}

/**
 * Per-state totals for a specific IST date, from the ledger, plus whether the
 * ledger had any rows for it. Callers that keep a legacy derived value should
 * prefer these totals only when `hasLedger` is true, so a pre-migration panel
 * does not read as an authoritative zero.
 */
export async function dayTotalsForDate(workerId, dateStr, { shift = null, pool = db._pool } = {}) {
  const sessions = await getSessionsForDate(workerId, dateStr, { pool });
  const startMs = new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
  const totals = sumIntervalsByState(sessions, {
    shift,
    nowMs: Date.now(),
    dayBounds: { startMs, endMs: startMs + 24 * 60 * 60 * 1000, day: dateStr },
  });
  return { hasLedger: sessions.length > 0, totals };
}

/**
 * Derived "today" totals for a worker, from the authoritative intervals. This is
 * what every reader (status endpoint, dashboards, screens) must call — do not
 * recompute idle anywhere else.
 */
export async function computeWorkerDayTotals(workerId, { shift = null, nowMs = Date.now(), pool = db._pool } = {}) {
  const sessions = await getSessionsForDay(workerId, { nowMs, pool });
  return sumIntervalsByState(sessions, { shift, nowMs });
}

export const __internal = { durationSecondsBetween };
