-- 091: Event Head media metadata columns.
-- Adds richer metadata to event_head_media (title, description, media_type,
-- year, size, uploaded_by, updated_at) used by the Media / Banners manager.
-- Idempotent: safe to re-run.
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS year INT;
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS size BIGINT;
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS uploaded_by TEXT;
ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
