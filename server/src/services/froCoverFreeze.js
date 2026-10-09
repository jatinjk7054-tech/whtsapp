import db from '../config/db.js';
import { isWorkerOnline } from '../socket.js';
import { IDLE_LIVE_FRESH_MS } from '../utils/froIdle.js';

// "Is this FRO currently being covered by somebody, and are they away?"
//
// A covered-away FRO must accrue NO idle. The reason is that their live row
// stopping refreshing carries no information about whether they were at the
// desk — it just means their panel is not open, because someone else is working
// their stations. Without this check the disposition deadline left on their row
// gets backdated to whenever it lapsed, and idle is credited for a period
// they were not present. That is what produced multi-hour phantom idle.
//
// The covered person is NOT always frozen:
//   - covered and refreshing their own row  -> present, accrue normally
//   - covered and gone quiet                -> away, frozen
// That second case is the one that matters, and it is the normal one: a cover is
// usually arranged precisely because the FRO is unavailable.
//
// A covered FRO who is also covering somebody (a chain) is judged on their OWN
// row, so the two relationships stay independent — Riya being covered by Priya
// does not stop Riya's own idle from accruing while she covers Meera.
//
// ONE freshness threshold, shared with the read paths: IDLE_LIVE_FRESH_MS. This
// service used its own 90-second constant, which meant a worker could be frozen
// for the purposes of the ledger yet still accruing on every read for the next
// minute and a half — the number freezing and the write not freezing at the same
// moment, which is worse than either being consistent.
export async function isCoveredAway(workerId, nowMs = Date.now()) {
  const id = String(workerId ?? '');
  if (!id) return false;

  let covers = null;
  try {
    const { rows } = await db._pool.query(
      `SELECT 1
         FROM work_as_sessions
        WHERE target_fro_worker_id = $1
          AND released_at IS NULL
          AND expires_at > now()
        LIMIT 1`,
      [id]
    );
    covers = rows;
  } catch (e) {
    // work_as_sessions may be absent, or the id may not be a worker uuid.
    // Default to NOT frozen: a genuine idle lapse must still be caught.
    return false;
  }
  if (!covers || covers.length === 0) return false;

  // Covered. Frozen only if their own row has gone quiet — otherwise they are
  // sitting at the desk working their own account while somebody covers a
  // station, and idle is real.
  try {
    const { rows } = await db._pool.query(
      `SELECT updated_at
         FROM fro_live_status
        WHERE worker_id = $1
        LIMIT 1`,
      [id]
    );
    const updatedAt = rows?.[0]?.updated_at ? new Date(rows[0].updated_at).getTime() : NaN;
    // No row at all -> away. An open panel socket is presence, so it counts as
    // "still at the desk" even when the last row write has aged out.
    if (!Number.isFinite(updatedAt)) return !isWorkerOnline(id);
    if (isWorkerOnline(id)) return false;
    return (nowMs - updatedAt) > IDLE_LIVE_FRESH_MS;
  } catch (e) {
    return true; // cannot prove liveness; err toward not billing idle
  }
}
