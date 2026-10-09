-- 175: Event Head — Monthly Planner festival-driven programme suggestions.
-- The Monthly Planner Activities section generates AI programme ideas per
-- (festival/day × selected NGO), then the user ticks the ones to export.
-- This table stores every generated batch so ticks persist across reloads and
-- the monthly download can list exactly the suggestions that were selected.
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
    CREATE TABLE IF NOT EXISTS event_head_festival_suggestions (
      id                SERIAL PRIMARY KEY,
      ngo_id            %s REFERENCES ngos(id) ON DELETE CASCADE,
      activity_id       INT REFERENCES event_head_activities(id) ON DELETE CASCADE,
      month             INT NOT NULL,
      year              INT NOT NULL,
      observance_date   DATE NOT NULL,
      festival          TEXT NOT NULL,
      beneficiary       TEXT,
      sector_name       TEXT,
      activity_name     TEXT,
      batch_no          INT NOT NULL DEFAULT 1,
      title             TEXT NOT NULL,
      format            TEXT,
      priority          TEXT,
      audience          TEXT,
      duration          TEXT,
      objective         TEXT,
      rationale         TEXT,
      materials         JSONB DEFAULT '[]'::jsonb,
      is_selected       BOOLEAN NOT NULL DEFAULT FALSE,
      suggested_event_id INT,
      created_by        TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      -- Re-running the generator for the same festival can never create a
      -- duplicate, and can never reset a user's existing ticks (a conflict is
      -- skipped rather than updated). NULLS NOT DISTINCT keeps rows identical
      -- except for a NULL activity_id/batch from colliding twice.
      UNIQUE NULLS NOT DISTINCT (activity_id, month, observance_date, festival, title),
      CHECK (month >= 1 AND month <= 12)
    )
  $SQL$, id_type);
END $$;

-- A month is read one NGO at a time on the planner page.
CREATE INDEX IF NOT EXISTS idx_event_head_festival_suggestions_ngo_month
  ON event_head_festival_suggestions (ngo_id, month, year);

-- The grid groups by date, so a date-range scan should stay fast.
CREATE INDEX IF NOT EXISTS idx_event_head_festival_suggestions_date
  ON event_head_festival_suggestions (observance_date);

-- Only ticked rows feed the download, so partial-index that flag.
CREATE INDEX IF NOT EXISTS idx_event_head_festival_suggestions_selected
  ON event_head_festival_suggestions (ngo_id, month, year)
  WHERE is_selected;