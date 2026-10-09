-- 171: fro_time_sessions — the authoritative, auditable interval ledger for the
-- FRO server-authoritative time state machine.
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- The old model folded idle time into counters on fro_live_status
-- (today_idle_seconds / idle_since) and a single per-day row on fro_daily_stats.
-- That made idle an emergent property of scattered write paths, and there was no
-- durable record of WHEN a worker was in which state. Two readers could and did
-- disagree about the same person at the same moment.
--
-- The rebuild makes the backend the single source of truth: every state change
-- (WORKING, IDLE, MEETING, PAUSED, INTERNET_PROBLEM, SLEEPING, HIDDEN,
-- OFF_SHIFT) closes the open interval and opens the next one. Daily aggregates
-- are derived from these intervals, never computed independently. This table is
-- the audit trail: you can always reconstruct "what state was this FRO in at
-- time T" and reconcile it against whatever a screen showed.
--
-- HARD INVARIANTS (enforced by the database, not by convention)
-- -------------------------------------------------------------
--   1. At most one OPEN interval per worker. The partial unique index below
--      makes a second open row unrepresentable, so a retry/double-emit cannot
--      create a "which one is current?" ambiguity.
--   2. No two authoritative intervals for the same worker may overlap in time.
--      The exclusion constraint (btree_gist) is the backstop against a
--      clock-ordering bug producing double-counted seconds.
--   3. An interval cannot end before it starts.
--
-- IDEMPOTENCY
-- -----------
-- Transitions are written by the app with `ON CONFLICT DO NOTHING` against the
-- open-session partial unique index, so replaying the same event (socket retry,
-- double click, duplicate disposition) is a no-op rather than a second interval.

CREATE TABLE IF NOT EXISTS public.fro_time_sessions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id        uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  -- Groups intervals that belong to one continuous run of the panel/state
  -- machine. Two different panel sessions can be distinguished for debugging.
  session_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  -- The authoritative state. Kept as text (not a Postgres enum) so a new state
  -- is an ADDITIVE migration, not a lock against ALTER TYPE.
  state            text        NOT NULL
                   CHECK (state IN (
                     'WORKING', 'IDLE', 'MEETING', 'PAUSED',
                     'INTERNET_PROBLEM', 'SLEEPING', 'HIDDEN', 'OFF_SHIFT'
                   )),
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  -- Stored so a long-closed interval does not need to be recomputed on every
  -- aggregate read. NULL while the interval is still open.
  duration_seconds integer,
  -- Free-text provenance for the transition: 'disposition', 'pause_start',
  -- 'pause_end', 'meeting_start', 'network_offline', 'page_hidden', 'shift_end',
  -- 'rollover', etc. Nullable so a manual/backfill row is allowed.
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fro_time_sessions_end_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- Invariant 1: at most one open interval per worker.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fro_time_sessions_open_per_worker
  ON public.fro_time_sessions (worker_id)
  WHERE ended_at IS NULL;

-- Aggregate reads: "all intervals for a worker overlapping [from, to)".
CREATE INDEX IF NOT EXISTS idx_fro_time_sessions_worker_started
  ON public.fro_time_sessions (worker_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fro_time_sessions_state_started
  ON public.fro_time_sessions (state, started_at DESC);

-- Invariant 2: no overlapping authoritative intervals per worker.
-- btree_gist lets the equality operator on worker_id combine with && on the
-- range. CONCURRENTLY is unavailable for ADD CONSTRAINT; the table is new and
-- empty so the plain form cannot block anything. Guarded by the catalog so the
-- migration is safe to re-run.
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fro_time_sessions_no_overlap'
  ) THEN
    ALTER TABLE public.fro_time_sessions
      ADD CONSTRAINT fro_time_sessions_no_overlap
      EXCLUDE USING gist (
        worker_id WITH =,
        tstzrange(started_at, COALESCE(ended_at, 'infinity'::timestamptz), '[)') WITH &&
      );
  END IF;
END $$;

COMMENT ON TABLE public.fro_time_sessions IS
  'Authoritative interval ledger for the FRO time state machine. Daily worked/idle aggregates are derived from these rows; fro_daily_stats is only a cached aggregate.';
COMMENT ON COLUMN public.fro_time_sessions.state IS
  'WORKING | IDLE | MEETING | PAUSED | INTERNET_PROBLEM | SLEEPING | HIDDEN | OFF_SHIFT';
COMMENT ON COLUMN public.fro_time_sessions.duration_seconds IS
  'Seconds the interval was held; NULL while ended_at IS NULL (still open).';
COMMENT ON COLUMN public.fro_time_sessions.reason IS
  'Why the interval was opened/closed, for audit (e.g. disposition, pause_start).';
