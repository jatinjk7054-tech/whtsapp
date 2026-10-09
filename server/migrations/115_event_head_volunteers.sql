-- 115: Event Head — store the Voluntary (volunteer + management) people
-- selected for an event when it is created. Stored as a JSONB array of
-- { name, ngo, team } entries so the selection can be shown on the event
-- (including past events) and reused as a reference the next time a new
-- event is created.
--
-- Idempotent: safe to re-run on an existing live database.
ALTER TABLE event_head_events ADD COLUMN IF NOT EXISTS volunteers JSONB DEFAULT '[]'::jsonb;