-- Per-FRO admin pause: freezes the FRO panel (like meeting mode) until resumed.
ALTER TABLE fro_live_status
  ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS paused_by TEXT NULL;
