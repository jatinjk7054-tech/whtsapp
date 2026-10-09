-- 150: Snapshot the incentive range's competition window onto each champion
-- announcement so History always shows the range's start time and end time,
-- even if the slab is later edited or deleted.
ALTER TABLE lead_champion_announcements
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

-- Backfill older announcements with their slab's current window so History
-- shows a time range even for winners announced before this migration.
UPDATE lead_champion_announcements a
SET started_at = s.started_at,
    ended_at = s.ended_at
FROM incentive_slabs s
WHERE a.slab_id = s.id
  AND s.started_at IS NOT NULL
  AND (a.started_at IS NULL OR a.ended_at IS NULL);