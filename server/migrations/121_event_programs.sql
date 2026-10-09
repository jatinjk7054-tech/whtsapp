-- ==========================================
-- EVENT PROGRAMS (Beneficiaries app)
-- Migration 121
-- Links operator events to programs so an event
-- holds the programs it runs; beneficiaries
-- marked (kit given) at that event are tracked on
-- the audit log via details.event_id.
-- ==========================================

CREATE TABLE IF NOT EXISTS event_programs (
  event_id INT NOT NULL,
  program_id INT NOT NULL,
  added_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event_id, program_id)
);

CREATE INDEX IF NOT EXISTS idx_event_programs_program ON event_programs(program_id);

-- FKs are guarded: operator_events / bnf_programs may not exist on fresh
-- deployments or isolated Query Runners, so only wire up the constraints
-- when both tables are present (matches the pattern used in 120).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'operator_events')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'event_programs_event_id_fkey' AND conrelid = to_regclass('event_programs')
     ) THEN
    ALTER TABLE event_programs
      ADD CONSTRAINT event_programs_event_id_fkey
      FOREIGN KEY (event_id) REFERENCES operator_events(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'bnf_programs')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'event_programs_program_id_fkey' AND conrelid = to_regclass('event_programs')
     ) THEN
    ALTER TABLE event_programs
      ADD CONSTRAINT event_programs_program_id_fkey
      FOREIGN KEY (program_id) REFERENCES bnf_programs(id) ON DELETE CASCADE;
  END IF;
END $$;