-- 071: Event Head — base `event_head_events` table.
-- The Event Head workspace stores its detailed events here (NGO → Sector →
-- Activity model). This file exists because migrations 072 / 091 / 092 only
-- ALTER or REFERENCE this table, so a fresh database needs the base table first.
--
-- IMPORTANT: run in numeric order 071 → 072 → 091 → 092.
-- Idempotent: safe to re-run on an existing live database (CREATE IF NOT EXISTS).
--
-- ngo_id must exactly match ngos.id's type for the FK, so we adopt the live
-- column type (int8/int4/uuid) instead of hardcoding INT — the same pattern
-- migration 072 uses for event_head_activities.

DO $$
DECLARE id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'ngos'::regclass AND a.attname = 'id';

  IF id_type IS NULL THEN id_type := 'bigint'; END IF;

  EXECUTE format($SQL$
    CREATE TABLE IF NOT EXISTS event_head_events (
      id                     SERIAL PRIMARY KEY,
      name                   TEXT NOT NULL,
      category               TEXT,
      activity_name          TEXT,
      ngo_id                 %s REFERENCES ngos(id) ON DELETE SET NULL,
      date                   DATE,
      start_time             TEXT,
      end_time               TEXT,
      venue                  TEXT,
      gps_location           TEXT,
      district               TEXT,
      state                  TEXT,
      organizer              TEXT,
      event_manager          TEXT,
      coordinator            TEXT,
      csr_partner            TEXT,
      donor                  TEXT,
      funding_source         TEXT,
      expected_beneficiaries INT,
      budget                 NUMERIC,
      description            TEXT,
      notes                  TEXT,
      status                 TEXT NOT NULL DEFAULT 'Draft',
      approval_status        TEXT NOT NULL DEFAULT 'Draft',
      priority               TEXT DEFAULT 'Medium',
      banner                 TEXT,
      created_by             TEXT,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )
  $SQL$, id_type);
END $$;

-- Useful for the NGO filter on the calendar / dashboard and month range scans.
CREATE INDEX IF NOT EXISTS idx_event_head_events_ngo ON event_head_events (ngo_id);
CREATE INDEX IF NOT EXISTS idx_event_head_events_date ON event_head_events (date);
CREATE INDEX IF NOT EXISTS idx_event_head_events_status ON event_head_events (status);