-- 084: Work-as (Acting FRO) station-scoped sessions.
-- Tracks which operator is acting as which FRO and which stations they claimed,
-- so two operators can work the same FRO's data on disjoint stations
-- simultaneously. Sessions auto-expire after 12 hours or when released.

CREATE TABLE IF NOT EXISTS work_as_sessions (
  id bigserial PRIMARY KEY,
  target_fro_worker_id uuid NOT NULL,
  operator_user_id text NOT NULL,
  operator_name text,
  stations jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_was_active_target
  ON work_as_sessions(target_fro_worker_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_was_active_operator
  ON work_as_sessions(operator_user_id)
  WHERE released_at IS NULL;
