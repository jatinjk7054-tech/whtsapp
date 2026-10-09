-- 162: Event Head — Monthly Planner suggestions.
-- AI programme ideas are generated per (activity, month, year). Previously they
-- lived only in browser state, so selecting an idea and downloading the monthly
-- planner report later was impossible after a reload.
-- This table stores every generated batch so the user's ticks persist and the
-- date-wise monthly report can list the suggestions they chose.
-- Idempotent: safe to re-run.

-- ngo_id must exactly match ngos.id's type for the FK, so we adopt the live
-- column type (int8/int4/uuid) instead of hardcoding INT — same pattern as 072.
DO $$
DECLARE id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'ngos'::regclass AND a.attname = 'id';

  IF id_type IS NULL THEN id_type := 'bigint'; END IF;

  EXECUTE format($SQL$
    CREATE TABLE IF NOT EXISTS event_head_planner_suggestions (
      id                  SERIAL PRIMARY KEY,
      ngo_id              %s REFERENCES ngos(id) ON DELETE CASCADE,
      activity_id         INT NOT NULL REFERENCES event_head_activities(id) ON DELETE CASCADE,
      month               INT NOT NULL,
      year                INT NOT NULL,
      batch_no            INT NOT NULL DEFAULT 1,
      title               TEXT NOT NULL,
      format              TEXT,
      priority            TEXT,
      audience            TEXT,
      duration            TEXT,
      objective           TEXT,
      rationale           TEXT,
      materials           JSONB DEFAULT '[]'::jsonb,
      is_selected         BOOLEAN NOT NULL DEFAULT FALSE,
      suggested_event_id  INT,
      created_by          TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (activity_id, month, year, batch_no, title),
      CHECK (month >= 1 AND month <= 12)
    )
  $SQL$, id_type);
END $$;

-- The monthly report always reads one NGO+month+year at a time.
CREATE INDEX IF NOT EXISTS idx_event_head_planner_suggestions_ngo_month
  ON event_head_planner_suggestions (ngo_id, month, year);

-- Reopening one activity's suggestion modal loads its own rows.
CREATE INDEX IF NOT EXISTS idx_event_head_planner_suggestions_activity
  ON event_head_planner_suggestions (activity_id, month, year);

-- Only ticked rows feed the download report, so partial-index that flag.
CREATE INDEX IF NOT EXISTS idx_event_head_planner_suggestions_selected
  ON event_head_planner_suggestions (ngo_id, month, year)
  WHERE is_selected;