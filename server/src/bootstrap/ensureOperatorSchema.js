import db from '../config/db.js';

// Operator event workspace — fully separate from event_head_*.
// Operator dashboard data: a daily event (with selfie) plus the state and
// operator assignment for that day. Idempotent on boot.
export async function ensureOperatorSchema() {
  await db._pool.query(`CREATE TABLE IF NOT EXISTS operator_events (
       id          SERIAL PRIMARY KEY,
       title       TEXT NOT NULL,
       description TEXT,
       event_date  DATE,
       start_time  TEXT,
       end_time    TEXT,
       location    TEXT,
       state       TEXT,
       city        TEXT,
       selfie_url  TEXT,
       created_by  TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       updated_at  TIMESTAMPTZ DEFAULT NOW()
     )`);

  await db._pool.query(`ALTER TABLE operator_events ADD COLUMN IF NOT EXISTS city TEXT`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS bnf_kits (
       id          SERIAL PRIMARY KEY,
       name        TEXT NOT NULL,
       is_active   BOOLEAN NOT NULL DEFAULT TRUE,
       created_by  TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW()
     )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS bnf_organizers (
       id          SERIAL PRIMARY KEY,
       name        TEXT NOT NULL,
       is_active   BOOLEAN NOT NULL DEFAULT TRUE,
       created_by  TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW()
     )`);

  // Beneficiaries mobile-app operators live in their own table (bnf_operators),
  // not as worker rows. The id type matches workers.id so operator_assignments
  // FKs stay compatible.
  const { rows: typeRows } = await db._pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
     FROM pg_attribute a
     WHERE a.attrelid = 'workers'::regclass AND a.attname = 'id'`
  );
  const workerIdType = (typeRows[0] && typeRows[0].t) || 'bigint';

  await db._pool.query(`CREATE TABLE IF NOT EXISTS bnf_operators (
       id          ${workerIdType} PRIMARY KEY,
       name        TEXT NOT NULL,
       email       TEXT,
       phone       TEXT,
       login_id    TEXT NOT NULL,
       password    TEXT NOT NULL,
       is_active   BOOLEAN NOT NULL DEFAULT TRUE,
       created_by  TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       updated_at  TIMESTAMPTZ DEFAULT NOW()
     )`);
  await db._pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS bnf_operators_login_id_key ON bnf_operators (login_id)`);

  // Migrate legacy operator worker rows (bnf_operator = true) into their own
  // table, preserving ids so existing operator_assignments stay valid.
  const { rows: hasBnfCol } = await db._pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'workers' AND column_name = 'bnf_operator'`
  );
  if (hasBnfCol.length > 0) {
    await db._pool.query(`
      INSERT INTO bnf_operators (id, name, email, phone, login_id, password, is_active, created_by, created_at)
      SELECT id, name, email, phone, login_id, password, is_active, created_by, created_at
      FROM workers
      WHERE bnf_operator = true
      ON CONFLICT (id) DO NOTHING
    `).catch(() => {});
  }

  await db._pool.query(`CREATE TABLE IF NOT EXISTS operator_assignments (
       id              SERIAL PRIMARY KEY,
       operator_id     ${workerIdType} REFERENCES bnf_operators(id) ON DELETE CASCADE,
       state           TEXT,
       city            TEXT,
       selfie_url      TEXT,
       event_id        INT REFERENCES operator_events(id) ON DELETE CASCADE,
       assignment_date DATE,
       created_at      TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE (operator_id, assignment_date, event_id)
     )`);

  // Existing databases created operator_assignments with its FK pointing at
  // workers(id). Re-point it to bnf_operators(id) — a no-op once done.
  await db._pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'operator_assignments'
          AND c.conname = 'operator_assignments_operator_id_fkey'
          AND pg_get_constraintdef(c.oid) LIKE '%workers%'
      ) THEN
        ALTER TABLE operator_assignments DROP CONSTRAINT operator_assignments_operator_id_fkey;
        ALTER TABLE operator_assignments ADD CONSTRAINT operator_assignments_operator_id_fkey
          FOREIGN KEY (operator_id) REFERENCES bnf_operators(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `).catch(() => {});

  await db._pool.query(`ALTER TABLE operator_assignments ADD COLUMN IF NOT EXISTS city TEXT`);
  await db._pool.query(`ALTER TABLE operator_assignments ADD COLUMN IF NOT EXISTS selfie_url TEXT`);
  await db._pool.query(`ALTER TABLE operator_assignments ADD COLUMN IF NOT EXISTS kit_id INT REFERENCES bnf_kits(id) ON DELETE SET NULL`);
  await db._pool.query(`ALTER TABLE operator_assignments ADD COLUMN IF NOT EXISTS organizer_id INT REFERENCES bnf_organizers(id) ON DELETE SET NULL`);

  // Default kit catalog seeded for immediate use — the operator app's Kit
  // dropdown is populated from bnf_kits. Same 'WHERE NOT EXISTS' guard as the
  // categories/benefits seed; already-present names are skipped on re-boot.
  const kits = [
    'Foodgrain Kit', 'Stationery Kit', 'Sanitary Pad', 'Sewing Machine',
    'Floor Mill', 'Blind Stick', 'School Bag & Kit', 'Meal Distribution',
    'Cloths Distribution', 'Snacks Distribution', 'Utensils Distribution',
    'Toys Distribution', 'Festival Kit Distribution', 'Tricycle',
    'Wheelchair', 'Rojghar Booth', 'Financial Support',
  ];
  for (const name of kits) {
    await db._pool.query(
      `INSERT INTO bnf_kits (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM bnf_kits WHERE name = $1)`,
      [name]
    ).catch(() => {});
  }

  const steps = [
    `CREATE INDEX IF NOT EXISTS idx_operator_events_date ON operator_events (event_date)`,
    `CREATE INDEX IF NOT EXISTS idx_operator_assignments_operator ON operator_assignments (operator_id, assignment_date)`,
    `CREATE INDEX IF NOT EXISTS idx_operator_assignments_event ON operator_assignments (event_id)`,
  ];

  for (const sql of steps) {
    await db._pool.query(sql);
  }
}