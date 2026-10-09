import db from '../config/db.js';

// Event Head hierarchy bootstrap — idempotent re-creation of the
// NGO → Sector → Activity foundation (backed by migration 072).
// Re-runs safely on every boot: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
// Needed because the Event Head workspace, dashboard and event endpoints all
// depend on these objects, and they are not always applied to the DB.
const SECTOR_SEEDS = [
  ['Education & Learning', 'Formal and informal education, learning support and literacy', 1],
  ['Livelihood, Skill & Employment Aatmanirbhar', 'Vocational skills, employment and self-reliance', 2],
  ['Technology & Assistive Devices', 'Assistive devices and accessible technology', 3],
  ['Independent Living & Mobility', 'Mobility aids, accessibility and independent daily living', 4],
  ['Health, Rehabilitation & Wellness', 'Health camps, rehabilitation and overall wellbeing', 5],
  ['Sports, Culture & Talent', 'Sports, arts, culture and talent development', 6],
  ['Women & Children with Disabilities', 'Support for women and children with disabilities', 7],
  ['Rights, Government Schemes & Accessibility', 'Rights awareness, government schemes and accessible spaces', 8],
  ['Products, Entrepreneurship & E-commerce', 'Products, entrepreneurship and e-commerce opportunities', 9],
  ['Social Inclusion & Community', 'Social inclusion and community participation', 10],
  ['Environment', 'Environmental initiatives, awareness and sustainability', 11],
  ['Nutrition', 'Nutrition, food security and distribution', 12],
];

const NGO_SEEDS = [
  ['BSCT', 'BSCT'],
  ['MANN', 'MANN'],
  ['AFLF', 'AFLF'],
];

export async function ensureEventHeadSchema() {
  await db._pool.query(`CREATE TABLE IF NOT EXISTS event_head_sectors (
       id          SERIAL PRIMARY KEY,
       name        TEXT NOT NULL UNIQUE,
       description TEXT,
       sort_order  INT DEFAULT 0,
       is_active   BOOLEAN DEFAULT TRUE,
       created_at  TIMESTAMPTZ DEFAULT NOW()
     )`);

  // ngo_id must exactly match ngos.id's type for the FK, so adopt the live
  // column type (int4/int8/uuid) instead of hardcoding INT.
  const { rows: typeRows } = await db._pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
     FROM pg_attribute a
     WHERE a.attrelid = 'ngos'::regclass AND a.attname = 'id'`
  );
  const ngoIdType = (typeRows[0] && typeRows[0].t) || 'bigint';

  await db._pool.query(`CREATE TABLE IF NOT EXISTS event_head_activities (
       id          SERIAL PRIMARY KEY,
       ngo_id      ${ngoIdType} REFERENCES ngos(id) ON DELETE CASCADE,
       sector_id   INT NOT NULL REFERENCES event_head_sectors(id) ON DELETE CASCADE,
       name        TEXT NOT NULL,
       description TEXT,
       banner      TEXT,
       status      TEXT NOT NULL DEFAULT 'Active',
       created_by  TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       updated_at  TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE (ngo_id, sector_id, name)
     )`);

  const steps = [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_event_head_activities_null_ngo
       ON event_head_activities (sector_id, name) WHERE ngo_id IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_event_head_activities_ngo ON event_head_activities (ngo_id)`,
    `CREATE INDEX IF NOT EXISTS idx_event_head_activities_sector ON event_head_activities (sector_id)`,
    `ALTER TABLE event_head_events ADD COLUMN IF NOT EXISTS sector_id INT REFERENCES event_head_sectors(id) ON DELETE SET NULL`,
    `ALTER TABLE event_head_events ADD COLUMN IF NOT EXISTS activity_id INT REFERENCES event_head_activities(id) ON DELETE SET NULL`,
    `ALTER TABLE event_head_events ADD COLUMN IF NOT EXISTS volunteers JSONB DEFAULT '[]'::jsonb`,
    `CREATE INDEX IF NOT EXISTS idx_event_head_events_sector ON event_head_events (sector_id)`,
    `CREATE INDEX IF NOT EXISTS idx_event_head_events_activity ON event_head_events (activity_id)`,
  ];

  for (const sql of steps) {
    await db._pool.query(sql);
  }

  for (const [name, description, sortOrder] of SECTOR_SEEDS) {
    await db._pool.query(
      `INSERT INTO event_head_sectors (name, description, sort_order, is_active)
       SELECT $1, $2, $3, TRUE
       WHERE NOT EXISTS (SELECT 1 FROM event_head_sectors s WHERE s.name = $1)`,
      [name, description, sortOrder]
    );
  }

  for (const [name, code] of NGO_SEEDS) {
    await db._pool.query(
      `INSERT INTO ngos (name, code, is_active)
       SELECT $1, $2, TRUE
       WHERE NOT EXISTS (SELECT 1 FROM ngos n WHERE UPPER(n.name) = UPPER($1) OR UPPER(n.code) = UPPER($2))`,
      [name, code]
    );
  }

  // Multi-activity join table (idempotent, mirrors migration 092).
  await db._pool.query(`CREATE TABLE IF NOT EXISTS event_head_event_activities (
       event_id    INT NOT NULL REFERENCES event_head_events(id) ON DELETE CASCADE,
       activity_id INT NOT NULL REFERENCES event_head_activities(id) ON DELETE CASCADE,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       PRIMARY KEY (event_id, activity_id)
     )`);
  await db._pool.query(`CREATE INDEX IF NOT EXISTS idx_event_head_event_activities_activity
       ON event_head_event_activities (activity_id)`);
  await db._pool.query(
    `INSERT INTO event_head_event_activities (event_id, activity_id)
     SELECT e.id, e.activity_id
     FROM event_head_events e
     WHERE e.activity_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM event_head_event_activities ea
         WHERE ea.event_id = e.id AND ea.activity_id = e.activity_id
       )`
  );

  // Media metadata columns (additive; safe to run any time).
  const MEDIA_COLUMNS = [
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS media_type TEXT`,
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS year INT`,
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS size BIGINT`,
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS uploaded_by TEXT`,
    `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
  ];
  const hasMedia = (await db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='event_head_media'`
  )).rows.length > 0;
  if (hasMedia) {
    for (const sql of MEDIA_COLUMNS) {
      try { await db._pool.query(sql); } catch { /* column may already exist */ }
    }
  }
}