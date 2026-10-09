import db from '../config/db.js';

// fro_live_status gains "work as" context: when an operator (abc) is assigned
// to work another FRO's stations (cbd), the live status row for the target FRO
// records who is actually operating it. It also carries the meeting/pause freeze
// start (frozen_at) so the server holds the disposition countdown during a held
// window instead of billing it as idle. It also carries the one-time settle-in
// grace (settle_until) granted on first panel presence of the day, after which
// the ordinary 4-minute window arms on its own. Reruns safely on every boot via
// ADD COLUMN IF NOT EXISTS.
export async function ensureFroLiveStatusSchema() {
  try {
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS work_as_operator_id uuid`);
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS work_as_operator_name text`);
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT FALSE`);
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ NULL`);
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS paused_by TEXT NULL`);
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ NULL`);
    await db._pool.query(`ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS settle_until TIMESTAMPTZ NULL`);
  } catch (error) {
    throw error;
  }
}

export default ensureFroLiveStatusSchema;