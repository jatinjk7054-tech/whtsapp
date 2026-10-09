-- 125: CRM login presence + logout tracking (UCS CRM web only; Flutter app
--      /auth/worker/login sessions are intentionally not tracked).
--
-- auth_sessions: one row per current/last CRM login subject. user_id is the
-- token-subject id (workers.id uuid, users.id / hr.id int, 0/-1 env logins).
--   - logged_in_at   recorded on every CRM login
--   - last_active_at refreshed by the FRO panel heartbeat (POST /fro/status)
--   - logged_out_at  set on explicit logout via POST /auth/logout
-- Presence: logged_in_at set, logged_out_at NULL, last_active_at fresh -> online.
--
-- auth_logout_events: append-only log of every explicit logout. Powers the
-- "Logouts Today" / "Total Logouts" columns in Telecaller Performance.

CREATE TABLE IF NOT EXISTS auth_sessions (
  user_id          TEXT PRIMARY KEY,
  client           TEXT NOT NULL DEFAULT 'crm',
  name             TEXT,
  role             TEXT,
  logged_in_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  logged_out_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_logout_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  client          TEXT NOT NULL DEFAULT 'crm',
  name            TEXT,
  role            TEXT,
  logged_out_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_logout_events_user ON auth_logout_events (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_logout_events_time ON auth_logout_events (logged_out_at);