-- 123_fro_idle_since.sql
-- Adds idle_since to fro_live_status so the NGO admin dashboard can show the
-- current idle streak ("Idle Xm") for FROs flagged idle by the 2-minute
-- call-idle detector running in the FRO panel. NULL = not idle.

ALTER TABLE fro_live_status ADD COLUMN IF NOT EXISTS idle_since timestamptz;
