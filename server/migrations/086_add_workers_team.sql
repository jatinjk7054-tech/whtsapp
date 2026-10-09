-- Migration 086: Add team allotment for FRO workers (UFS1-UFS4)
-- Used by the Accounts "Team-wise Collection" report and the HR team picker.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS team text;
CREATE INDEX IF NOT EXISTS idx_workers_team ON workers(team);