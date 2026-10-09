import db from '../config/db.js';
import { istDayBounds } from '../utils/ist.js';

// IST billing-month key (e.g. "2026-08"). The work "cycle" is per calendar month.
export function monthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${values.year}-${values.month}`;
}

// cycle_key uniquely identifies a FRO's ordered queue for a given scope + month.
// There is no "campaigns" table in this system — the work cycle is the
// (station, ngo, new/old tab) scope for the current billing month.
export function cycleKey({ ngoId = null, station = null, tab = 'new', date = new Date() }) {
  const k = (v) => (v == null || v === '' || v === 'all' ? 'all' : String(v));
  return `${k(ngoId)}:${k(station)}:${tab}:${monthKey(date)}`;
}

const RE_SORTABLE = ["'PENDING'", "'IN_PROGRESS'", "'BUTTON_PRESSED'"];

// ── Disposition classification (single source) ───────────────────────────────
// Retryable not-connected dispositions keep the donor ACTIVE in the queue (so
// it can be reworked next time); every other disposition is treated as terminal
// for the queue (donor is removed from the active set so it never reappears).
export const RETRYABLE_NOT_CONNECTED_DETAILS = new Set([
  'ringing', 'unreachable', 'busy', 'out_of_coverage', 'voicemail', 'call_waiting', 'switched_off',
  'ringing_voicemail', 'busy_call_waiting', 'ooc_unreachable_network',
]);

export function classifyDisposition(detail) {
  const retryable = !!detail && RETRYABLE_NOT_CONNECTED_DETAILS.has(detail);
  return { retryable, terminal: !retryable };
}

// The work "cycle" is one FRO + (station/ngo scope) for a billing month. Rows
// are keyed by (worker_id, donor_id, ngo_id, cycle_key) so a donor can never be
// enqueued twice for the same worker+scope.
export function scopeKey({ ngoId = null, station = null, tab = 'new', date = new Date() }) {
  return cycleKey({ ngoId, station, tab, date });
}

// Build the UPSERT SQL that reconciles the worker's ordered donor list into
// work_queue for a cycle. Pure (no DB) so it's unit-testable. Position is
// seeded ONCE on INSERT (the donor's index within `donors` = FIFO order) and is
// then STABLE for the cycle — on conflict we do NOT refresh position. This keeps
// a durable "position" column that a strict forward cursor can walk with
// `position > lastPosition ORDER BY position ASC LIMIT 1`, and avoids dense
// re-indexing that would re-serve already-processed donors. New rows (fresh
// donors) are inserted with their current list index; a handled donor's row is
// never resurrected via status because terminal rows keep their terminal status.
export function buildReconcileSql({ workerId, operatorId = null, donors, ngoId = null, station = null, tab = 'new' }) {
  const ck = cycleKey({ ngoId, station, tab });
  const now = new Date().toISOString();
  const rows = [];
  const params = [workerId, operatorId, ck, station, now];
  let pi = params.length;
  for (let i = 0; i < donors.length; i++) {
    const d = donors[i];
    const donorId = d.donor_id ?? d.id;
    const dngo = d.ngo_id ?? ngoId ?? null;
    params.push(donorId, dngo, i);
    rows.push(`($1, $2, $3, $4, $${++pi}, $${++pi}, $${++pi}, $5)`);
  }
  const conflictWhere = RE_SORTABLE.join(', ');
  const sql = `
    INSERT INTO work_queue (worker_id, operator_id, cycle_key, station, donor_id, ngo_id, position, updated_at)
    VALUES ${rows.join(', ')}
    ON CONFLICT (worker_id, donor_id, ngo_id, cycle_key)
    DO UPDATE SET
      station = EXCLUDED.station,
      updated_at = EXCLUDED.updated_at
      WHERE work_queue.status IN (${conflictWhere})
  `;
  return { sql, params, cycleKey: ck };
}

// Reconcile the worker's ordered donor list into work_queue for a cycle.
// Inserts new rows (seeding a stable position) and refreshes metadata for rows
// still active without re-indexing their position; already DISPOSED/COMPLETED/
// EXCEPTION rows keep their terminal status (never resurrect a handled donor).
// Duplicate (worker, donor, ngo, cycle) rows are impossible via the DB unique
// constraint.
export async function reconcileQueue({ workerId, operatorId = null, donors, ngoId = null, station = null, tab = 'new' }) {
  const { sql, params, cycleKey: ck } = buildReconcileSql({ workerId, operatorId, donors, ngoId, station, tab });
  let inserted = 0;
  try {
    const res = await db._pool.query(sql, params);
    inserted = res.rowCount || 0;
  } catch (err) {
    if (err.code === '42P01' || /relation "work_queue" does not exist/i.test(err.message)) {
      console.warn('work_queue table missing — running migration 087 is required. Queue reconcile skipped.');
      return { cycleKey: ck, inserted: 0, reconciled: 0 };
    }
    throw err;
  }
  return { cycleKey: ck, inserted, reconciled: donors.length };
}

// Pick the next donor to show: the lowest-position active row for the cycle
// that is not currently marked as being viewed by the caller, respecting the
// worker's current resume position. Returns the queue row + progress, or null
// when the cycle is exhausted.
export async function getNextQueueRow({ workerId, ngoId = null, station = null, tab = 'new', operatorId = null }) {
  const ck = cycleKey({ ngoId, station, tab });
  const { data } = await db
    .from('work_queue')
    .select('*')
    .eq('worker_id', workerId)
    .eq('cycle_key', ck)
    .in('status', ['PENDING', 'IN_PROGRESS', 'BUTTON_PRESSED'])
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data || null;
}

export async function getNextQueueRowAfter({ workerId, donorId, ngoId = null, station = null, tab = 'new' }) {
  const ck = cycleKey({ ngoId, station, tab });
  const params = [workerId, ck, donorId, ngoId ?? null];
  const sql = `
    SELECT * FROM work_queue
    WHERE worker_id = $1 AND cycle_key = $2
      AND status IN ('PENDING','IN_PROGRESS','BUTTON_PRESSED')
      AND NOT (donor_id = $3 AND ngo_id IS NOT DISTINCT FROM $4)
    ORDER BY position ASC LIMIT 1
  `;
  const { rows } = await db._pool.query(sql, params);
  return rows[0] || null;
}

// Count how many active donors remain in the cycle (for "N of M" progress).
export async function countQueueRows({ workerId, ngoId = null, station = null, tab = 'new' }) {
  const ck = cycleKey({ ngoId, station, tab });
  const { count } = await db
    .from('work_queue')
    .select('id', { count: 'exact', head: true })
    .eq('worker_id', workerId)
    .eq('cycle_key', ck)
    .in('status', ['PENDING', 'IN_PROGRESS', 'BUTTON_PRESSED']);
  return count || 0;
}

// All active (non-terminal) queue rows for a cycle, ordered by position — the
// authoritative ordered list the backend serves the "current donor" from.
export async function getActiveQueueRows({ workerId, ngoId = null, station = null, tab = 'new' }) {
  const ck = cycleKey({ ngoId, station, tab });
  const params = [workerId, ck];
  const sql = `
    SELECT * FROM work_queue
    WHERE worker_id = $1 AND cycle_key = $2
      AND status IN ('PENDING','IN_PROGRESS','BUTTON_PRESSED')
    ORDER BY position ASC
  `;
  const { rows } = await db._pool.query(sql, params);
  return rows || [];
}

export async function markShown({ workerId, donorId, ngoId = null, station = null, tab = 'new', position }) {
  const ck = cycleKey({ ngoId, station, tab });
  const res = await db._pool.query(
    `UPDATE work_queue SET status = 'IN_PROGRESS',
            first_seen_at = COALESCE(first_seen_at, now()),
            last_shown_at = now(), updated_at = now()
     WHERE worker_id = $1 AND cycle_key = $2 AND donor_id = $3`,
    [workerId, ck, donorId]
  );
  return res.rowCount > 0;
}

// Reflect a disposition on the worker's active queues. Matches on worker_id +
// donor_id across ALL cycles (tabs/stations) so a disposition removes the donor
// from every active queue at once — a handled donor never reappears today.
//
// Same-day suppression (business rule): if the donor already has ANY disposition
// TODAY (IST) for this worker, it must stay out of the active queue until the
// next day, EVEN for a retryable disposition (e.g. ringing/busy). So when we
// would reset a row to PENDING (disposed==false), we skip doing so if a
// same-day disposition log already exists. Tomorrow (new IST day) a retryable
// donor becomes eligible again via the normal reconcile path.
//
//   disposed == true  → status = 'DISPOSED'        (terminal: done/not_interested/…)
//   disposed == false → status = 'PENDING' ONLY if no same-day disposition
//                       for this worker (otherwise the row stays DISPOSED so the
//                       donor cannot be re-enqueued the same day).
export async function markDisposed({ workerId, donorId, disposed = false }) {
  const { start, end } = istDayBounds();
  const res = await db._pool.query(
    `UPDATE work_queue
        SET status = $3, disposed_at = CASE WHEN $3 = 'DISPOSED' THEN now() ELSE NULL END, updated_at = now()
      WHERE worker_id = $1 AND donor_id = $2
        AND status IN ('PENDING','IN_PROGRESS','BUTTON_PRESSED')
        AND (
          $3 = 'DISPOSED'
          OR NOT EXISTS (
            SELECT 1 FROM fro_donor_logs l
            WHERE l.donor_id = work_queue.donor_id
              AND l.fro_worker_id = $1
              AND l.action = 'disposition'
              AND l.created_at >= $4 AND l.created_at < $5
          )
        )`,
    [workerId, donorId, disposed ? 'DISPOSED' : 'PENDING', start.toISOString(), end.toISOString()]
  );
  return res.rowCount > 0;
}

// Hard-remove a donor from the work_queue for a given worker across ALL cycles
// (new/old and every ngo scope). Used when an assignment is deleted outright
// (e.g. a DND disposition that removes the FRO's station/agent assignment) so
// the donor can never be re-enqueued for this worker again.
export async function removeFromQueue({ workerId, donorId }) {
  const res = await db._pool.query(
    `DELETE FROM work_queue
      WHERE worker_id = $1 AND donor_id = $2`,
    [workerId, donorId]
  );
  return res.rowCount > 0;
}

// Remove any active (PENDING/IN_PROGRESS/BUTTON_PRESSED) rows for a cycle
// whose donor is no longer part of the current ordered set (e.g. the donor got
// disposed/terminal outside this live flow). This keeps a handled donor from
// lingering in the active queue and reappearing.
export async function clearActiveRowsNotIn({ workerId, donorIds, ngoId = null, station = null, tab = 'new' }) {
  const ck = cycleKey({ ngoId, station, tab });
  const params = [workerId, ck];
  let sql = `
    DELETE FROM work_queue
    WHERE worker_id = $1 AND cycle_key = $2
      AND status IN ('PENDING','IN_PROGRESS','BUTTON_PRESSED')
  `;
  if (donorIds && donorIds.length > 0) {
    const ph = donorIds.map((_, i) => `$${params.length + 1 + i}`).join(', ');
    params.push(...donorIds);
    sql += ` AND donor_id NOT IN (${ph})`;
  }
  await db._pool.query(sql, params);
}
