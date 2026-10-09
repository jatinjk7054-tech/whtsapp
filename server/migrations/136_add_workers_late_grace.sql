-- Migration 136: Per-person late grace (NULL = default 180).
-- Half-day / full-day limits scale proportionally in code.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS late_grace_minutes integer NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workers_late_grace_check'
  ) THEN
    ALTER TABLE workers ADD CONSTRAINT workers_late_grace_check
      CHECK (late_grace_minutes IS NULL OR (late_grace_minutes >= 30 AND late_grace_minutes <= 480));
  END IF;
END $$;
