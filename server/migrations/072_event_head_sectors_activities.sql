-- 072: Event Head — NGO → Sector → Activity foundation (Digital Team workspace).
-- Adds event_head_sectors (12 seeded sectors), event_head_activities, and
-- links event_head_events to sector/activity. Idempotent: safe to re-run.

-- ─── SECTORS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_head_sectors (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the 12 fixed sectors only if they do not already exist.
INSERT INTO event_head_sectors (name, description, sort_order, is_active)
SELECT v.name, v.description, v.sort_order, TRUE
FROM (VALUES
  ('Education & Learning', 'Formal and informal education, learning support and literacy', 1),
  ('Livelihood, Skill & Employment Aatmanirbhar', 'Vocational skills, employment and self-reliance', 2),
  ('Technology & Assistive Devices', 'Assistive devices and accessible technology', 3),
  ('Independent Living & Mobility', 'Mobility aids, accessibility and independent daily living', 4),
  ('Health, Rehabilitation & Wellness', 'Health camps, rehabilitation and overall wellbeing', 5),
  ('Sports, Culture & Talent', 'Sports, arts, culture and talent development', 6),
  ('Women & Children with Disabilities', 'Support for women and children with disabilities', 7),
  ('Rights, Government Schemes & Accessibility', 'Rights awareness, government schemes and accessible spaces', 8),
  ('Products, Entrepreneurship & E-commerce', 'Products, entrepreneurship and e-commerce opportunities', 9),
  ('Social Inclusion & Community', 'Social inclusion and community participation', 10),
  ('Environment', 'Environmental initiatives, awareness and sustainability', 11),
  ('Nutrition', 'Nutrition, food security and distribution', 12)
) AS v(name, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM event_head_sectors s WHERE s.name = v.name);

-- ─── ACTIVITIES ────────────────────────────────────────────────────────────
-- ngo_id must exactly match ngos.id's type for the FK, so we adopt the
-- live column type (int8/int4/uuid) instead of hardcoding INT.
DO $$
DECLARE id_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'ngos'::regclass AND a.attname = 'id';

  IF id_type IS NULL THEN id_type := 'bigint'; END IF;

  EXECUTE format('
    CREATE TABLE IF NOT EXISTS event_head_activities (
      id          SERIAL PRIMARY KEY,
      ngo_id      %s REFERENCES ngos(id) ON DELETE CASCADE,
      sector_id   INT NOT NULL REFERENCES event_head_sectors(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      banner      TEXT,
      status      TEXT NOT NULL DEFAULT ''Active'',
      created_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (ngo_id, sector_id, name)
    )', id_type);
END $$;

-- Enforce uniqueness for "All NGOs" (NULL ngo_id) activities too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_head_activities_null_ngo
  ON event_head_activities (sector_id, name) WHERE ngo_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_head_activities_ngo ON event_head_activities (ngo_id);
CREATE INDEX IF NOT EXISTS idx_event_head_activities_sector ON event_head_activities (sector_id);

-- ─── EVENTS (link to sector/activity; backward compatible, nullable) ───────
ALTER TABLE event_head_events ADD COLUMN IF NOT EXISTS sector_id INT REFERENCES event_head_sectors(id) ON DELETE SET NULL;
ALTER TABLE event_head_events ADD COLUMN IF NOT EXISTS activity_id INT REFERENCES event_head_activities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_event_head_events_sector ON event_head_events (sector_id);
CREATE INDEX IF NOT EXISTS idx_event_head_events_activity ON event_head_events (activity_id);