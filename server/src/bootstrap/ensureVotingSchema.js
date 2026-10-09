import db from '../config/db.js';

// Award ceremony voting — strictly-sequential, anonymous, one-department-at-a-time.
//
// Creates the six voting_departments in ceremony order, then seeds the
// Developers group. Developers are NOT a `workers.department` value (the HR
// worker dropdown has no such entry), so that group is defined purely by an
// explicit member list. Those same three people sit in Digital, so Digital gets
// 'exclude' rows for them — otherwise they would appear in two groups and be
// able to vote in both turns.
//
// The seed is additive and never destructive: an existing ceremony's department
// rows are left alone, and member rows are only inserted where absent. That way
// a re-boot cannot undo an HR member edit made through the control panel.
//
// Idempotent on boot.

const DEFAULT_GROUPS = [
  { name: 'FRO', match: 'FRO' },
  { name: 'Digital', match: 'Digital' },
  { name: 'Developers', match: null, is_locked: true },
  // HR-Recruiter people are part of HR and vote in the same group.
  { name: 'HR', match: 'HR, HR-Recruiter' },
  { name: 'Admin', match: 'Admin' },
  { name: 'Housekeeping', match: 'Housekeeping' },
];

// login_id values, per HR. Resolved against workers at seed time; a login that
// does not exist yet is skipped rather than failing the boot, and HR can add the
// person later from the control panel's member picker.
const DEVELOPER_LOGIN_IDS = ['shawn@ufs', 'sohan.khedekar@ufs', 'omkar.mohite@ufs'];

async function ensureTables() {
  await db._pool.query(`CREATE TABLE IF NOT EXISTS voting_departments (
    id               SERIAL PRIMARY KEY,
    name             TEXT NOT NULL,
    order_index      INT NOT NULL,
    match_department TEXT,
    is_locked        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS voting_department_members (
    id            SERIAL PRIMARY KEY,
    department_id INT NOT NULL REFERENCES voting_departments(id) ON DELETE CASCADE,
    worker_id     UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    is_excluded   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (department_id, worker_id)
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS voting_sessions (
    id                    SERIAL PRIMARY KEY,
    title                 TEXT NOT NULL,
    tagline               TEXT,
    award_label           TEXT NOT NULL DEFAULT 'Star of the Department',
    status                TEXT NOT NULL DEFAULT 'draft',
    allow_self_vote       BOOLEAN NOT NULL DEFAULT FALSE,
    turn_minutes          INT NOT NULL DEFAULT 5,
    current_department_id INT REFERENCES voting_departments(id) ON DELETE SET NULL,
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    created_by            TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS voting_turns (
    id            SERIAL PRIMARY KEY,
    session_id    INT NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
    department_id INT NOT NULL REFERENCES voting_departments(id) ON DELETE CASCADE,
    order_index   INT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    opens_at      TIMESTAMPTZ,
    closes_at     TIMESTAMPTZ,
    opened_by     TEXT,
    opened_at     TIMESTAMPTZ,
    closed_by     TEXT,
    closed_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (session_id, department_id)
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS voting_ballots (
    id            BIGSERIAL PRIMARY KEY,
    session_id    INT NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
    turn_id       INT NOT NULL REFERENCES voting_turns(id) ON DELETE CASCADE,
    department_id INT NOT NULL REFERENCES voting_departments(id) ON DELETE CASCADE,
    nominee_id    UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    team_key      TEXT NOT NULL DEFAULT '',
    voter_hash    TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (turn_id, voter_hash, team_key)
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS voting_audit (
    id         BIGSERIAL PRIMARY KEY,
    session_id INT REFERENCES voting_sessions(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    detail     TEXT,
    actor      TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  const steps = [
    `CREATE INDEX IF NOT EXISTS idx_voting_departments_order ON voting_departments (order_index)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_department_members_dept ON voting_department_members (department_id)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_department_members_worker ON voting_department_members (worker_id)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_turns_session ON voting_turns (session_id, order_index)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_ballots_turn ON voting_ballots (turn_id)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_ballots_nominee ON voting_ballots (nominee_id)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_ballots_session_dept ON voting_ballots (session_id, department_id)`,
    `CREATE INDEX IF NOT EXISTS idx_voting_audit_session ON voting_audit (session_id, created_at)`,
  ];

  for (const sql of steps) {
    await db._pool.query(sql);
  }

  await upgradeTeamBallots();
}

/**
 * Bring an already-created voting_ballots table up to the one-pick-per-team shape.
 *
 * CREATE TABLE IF NOT EXISTS silently leaves an older table alone, so the column
 * and the constraint swap have to be stated separately for installs that predate
 * team voting. Idempotent, and deliberately a no-op on a fresh install.
 */
async function upgradeTeamBallots() {
  await db._pool.query(
    'ALTER TABLE voting_ballots ADD COLUMN IF NOT EXISTS team_key TEXT NOT NULL DEFAULT \'\'',
  );

  // Existing ballots were one pick for the whole department, so give each the
  // team its nominee was on. A team edited since the vote is unknowable from
  // here, and the alternative — dropping history — is worse than a stale key.
  await db._pool.query(
    `UPDATE voting_ballots b
        SET team_key = lower(btrim(COALESCE(w.team, '')))
       FROM workers w
      WHERE w.id = b.nominee_id
        AND b.team_key = ''`,
  );

  // The old constraint is what stopped a second vote; the new one stops a second
  // pick for the same team while allowing the other teams on that ballot. It is
  // located by its columns rather than by name, because 158_voting.sql created
  // it unnamed and so it carries a generated name — and leaving it in place
  // would reject the second row of every multi-team ballot.
  await db._pool.query(
    `DO $$
     DECLARE
       old_constraint TEXT;
     BEGIN
       SELECT c.conname INTO old_constraint
         FROM pg_constraint c
        WHERE c.conrelid = 'voting_ballots'::regclass
          AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                 FROM unnest(c.conkey) AS k
                 JOIN pg_attribute a
                   ON a.attrelid = c.conrelid AND a.attnum = k) = ARRAY['turn_id', 'voter_hash'];

       IF old_constraint IS NOT NULL THEN
         EXECUTE format('ALTER TABLE voting_ballots DROP CONSTRAINT %I', old_constraint);
       END IF;
     END $$`,
  );
  await db._pool.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1
           FROM pg_constraint c
          WHERE c.conrelid = 'voting_ballots'::regclass
            AND c.contype = 'u'
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                   FROM unnest(c.conkey) AS k
                   JOIN pg_attribute a
                     ON a.attrelid = c.conrelid AND a.attnum = k) = ARRAY['team_key', 'turn_id', 'voter_hash']
       ) THEN
         ALTER TABLE voting_ballots
           ADD CONSTRAINT voting_ballots_turn_voter_team_key UNIQUE (turn_id, voter_hash, team_key);
       END IF;
     END $$`,
  );

  await db._pool.query(
    'CREATE INDEX IF NOT EXISTS idx_voting_ballots_turn_voter ON voting_ballots (turn_id, voter_hash)',
  );
}

async function seedDepartments() {
  for (let i = 0; i < DEFAULT_GROUPS.length; i += 1) {
    const g = DEFAULT_GROUPS[i];
    await db._pool.query(
      `INSERT INTO voting_departments (name, order_index, match_department, is_locked)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM voting_departments WHERE lower(btrim(name)) = lower($1))`,
      [g.name, i, g.match, !!g.is_locked],
    );
  }

  // Migrate installs seeded before HR-Recruiters joined the HR group. Only the
  // untouched default ('HR') is rewritten, so a manual HR edit is never clobbered.
  await db._pool.query(
    `UPDATE voting_departments
        SET match_department = 'HR, HR-Recruiter'
      WHERE lower(btrim(name)) = 'hr'
        AND lower(btrim(COALESCE(match_department, ''))) = 'hr'`,
  );
}

async function seedDeveloperMembers() {
  const { rows: found } = await db._pool.query(
    `SELECT id, login_id FROM workers WHERE lower(login_id) = ANY($1::text[])`,
    [DEVELOPER_LOGIN_IDS.map((l) => l.toLowerCase())],
  );
  if (!found.length) {
    console.warn(
      `[ensureVotingSchema] Developers group is empty — none of these login_ids exist in workers: ${DEVELOPER_LOGIN_IDS.join(', ')}. Add them from the HR control panel.`,
    );
    return;
  }

  const { rows: depts } = await db._pool.query(
    `SELECT id, name FROM voting_departments WHERE lower(btrim(name)) IN ('developers', 'digital')`,
  );
  const developers = depts.find((d) => String(d.name).toLowerCase() === 'developers');
  const digital = depts.find((d) => String(d.name).toLowerCase() === 'digital');
  if (!developers) return;

  for (const w of found) {
    // Developers: explicit include, so the roster becomes exactly these rows.
    await db._pool.query(
      `INSERT INTO voting_department_members (department_id, worker_id, is_excluded)
       SELECT $1, $2, FALSE
       WHERE NOT EXISTS (
         SELECT 1 FROM voting_department_members WHERE department_id = $1 AND worker_id = $2
       )`,
      [developers.id, w.id],
    ).catch(() => {});

    // Digital: same person, removed, so they cannot vote in both turns.
    if (digital) {
      await db._pool.query(
        `INSERT INTO voting_department_members (department_id, worker_id, is_excluded)
         SELECT $1, $2, TRUE
         WHERE NOT EXISTS (
           SELECT 1 FROM voting_department_members WHERE department_id = $1 AND worker_id = $2
         )`,
        [digital.id, w.id],
      ).catch(() => {});
    }
  }
}

export async function ensureVotingSchema() {
  await ensureTables();
  await seedDepartments();
  await seedDeveloperMembers();
}
