import db from '../config/db.js';

// Auth-session schema bootstrap — mirrors migration 125. Re-runs safely on
// every boot (CREATE ... IF NOT EXISTS), so a fresh DB gets the tables even
// before the tracked migration is applied.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     user_id          TEXT PRIMARY KEY,
     client           TEXT NOT NULL DEFAULT 'crm',
     name             TEXT,
     role             TEXT,
     logged_in_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_active_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     logged_out_at    TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS auth_logout_events (
     id              BIGSERIAL PRIMARY KEY,
     user_id         TEXT NOT NULL,
     client          TEXT NOT NULL DEFAULT 'crm',
     name            TEXT,
     role            TEXT,
     logged_out_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_logout_events_user ON auth_logout_events (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_logout_events_time ON auth_logout_events (logged_out_at)`,
];

export async function ensureAuthSessionSchema() {
  for (const s of STATEMENTS) {
    try {
      await db._pool.query(s);
    } catch (e) {
      console.warn('[auth session schema] skip:', e?.message || String(e));
    }
  }
}