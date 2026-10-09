-- Migration 099: Assets register — grouped-quantity + location + team leader.
-- Adds support for the Office Asset Register Excel model:
--   quantity   — grouped count lines (Android / Nokia mobiles without per-item rows)
--   location   — cabin / department location (AFLF Cabin, MANN Cabin, BPO Cabin...)
--   team_leader — team leader captured from the Computer sheet (DESK/LAP codes)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS quantity int NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS team_leader text;