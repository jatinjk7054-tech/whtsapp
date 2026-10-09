import cron from 'node-cron';
import db from '../config/db.js';
import { emitRealtime } from '../socket.js';
import { makeNonOverlap } from '../utils/noOverlap.js';
import { commitIdleOnExit } from './froIdleCommit.js';

// Auto-logout for FRO panels. The manual Sign out button was removed from the
// FRO panel, so every open FRO session is closed automatically once the
// worker's shift end time (+ AUTO_LOGOUT_AFTER_MIN grace) has passed. Each
// worker keeps their own end time (workers.shift_end_time) and falls back to
// the org-wide office_end_time setting, then to 19:00 — the same resolution
// getOfficeEnd uses. A targeted socket event bounces the panel, and the
// updateLiveStatus 401 guard (auth_sessions.logged_out_at) is the server-side
// safety net. Re-login reopens the session normally (touchLogin clears
// logged_out_at).

const AUTO_LOGOUT_AFTER_MIN = 30;
const DEFAULT_END = '19:00';
const cronJobs = [];
let running = false;

const istNow = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);

export async function runFroAutoLogout() {
  const now = istNow();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nowIso = new Date().toISOString();

  let sessions = [];
  try {
    const { rows } = await db._pool.query(
      `SELECT s.user_id, s.name, s.role,
              w.shift_end_time AS shift_end_time,
              st.value AS office_end_time
       FROM auth_sessions s
       LEFT JOIN workers w ON w.id::text = s.user_id
       LEFT JOIN settings st ON st.key = 'office_end_time'
       WHERE s.logged_out_at IS NULL
         AND (s.role = 'fro' OR lower(trim(w.department)) = 'fro')`
    );
    sessions = rows;
  } catch (e) {
    // auth_sessions may be absent until migration 125 is applied.
    return;
  }

  const due = sessions.filter((s) => {
    const raw = String(s.shift_end_time || s.office_end_time || DEFAULT_END).trim();
    const [hour, minute] = raw.split(':').map(Number);
    const endMinutes = (hour || 19) * 60 + (minute || 0);
    return nowMinutes >= endMinutes + AUTO_LOGOUT_AFTER_MIN;
  });

  const userIds = due.map((s) => s.user_id).filter(Boolean);
  if (userIds.length === 0) return;

  try {
    for (const s of due) {
      await db._pool.query(
        `INSERT INTO auth_logout_events (user_id, client, name, role, logged_out_at)
         VALUES ($1, 'crm', $2, $3, $4)`,
        [s.user_id, s.name || null, s.role || 'fro', nowIso]
      );
    }
  } catch (e) {
    // Non-fatal: logout log may be absent — presence close is the core part.
  }

  try {
    await db._pool.query(
      `UPDATE auth_sessions SET logged_out_at = $2
       WHERE logged_out_at IS NULL AND user_id = ANY($1::text[])`,
      [userIds, nowIso]
    );
  } catch (e) {
    // Non-fatal.
  }

  try {
    // Fold any open idle period into the day total BEFORE going offline —
    // otherwise a forced logout (shift end) silently drops the idle seconds the
    // FRO accrued but never resumed out of, and the monthly salary total misses
    // the tail. The per-worker cap is that worker's own shift end, so the grace
    // minutes after they went home are never billed as idle.
    for (const s of due) {
      if (!s.user_id) continue;
      const raw = String(s.shift_end_time || s.office_end_time || DEFAULT_END).trim();
      const [h, m] = raw.split(':').map(Number);
      const capMs = istNow().setUTCHours(h || 19, m || 0, 0, 0);
      try {
        await commitIdleOnExit(s.user_id, Date.now(), capMs);
      } catch (e) {
        // Non-fatal: continue with the rest of the batch.
      }
    }
  } catch (e) {
    // Non-fatal: live status row may not exist for every session.
  }

  try {
    await db._pool.query(
      `UPDATE fro_live_status
          SET status = 'offline',
              updated_at = $2
        WHERE worker_id = ANY($1::text[])`,
      [userIds, nowIso]
    );
  } catch (e) {
    // Non-fatal.
  }

  // Target only the due workers: a global broadcast would bounce FROs whose
  // personal shift end (+ grace) has not arrived yet. The owner room matches
  // whatever identity the panel is currently using (work-as panels join the
  // impersonated owner's room too).
  for (const id of userIds) {
    emitRealtime('fro:force-logout', { at: nowIso, auto: true }, `worker:${id}`);
  }

  console.log(`[froAutoLogout] Logged out ${userIds.length} FRO session(s) past shift end + ${AUTO_LOGOUT_AFTER_MIN} min`);
}

function start() {
  if (running) return;
  running = true;
  const runNoOverlap = makeNonOverlap('fro auto-logout', runFroAutoLogout);
  cronJobs.push(cron.schedule('20 */5 * * * *', () => runNoOverlap().catch(() => {})));
  console.log(`Scheduled: 5-min auto-logout sweep for FROs past shift end + ${AUTO_LOGOUT_AFTER_MIN} min`);
}

function stop() {
  for (const job of cronJobs) job.stop();
  cronJobs.length = 0;
  running = false;
  console.log('FRO auto-logout scheduler stopped');
}

start();

export { start, stop };