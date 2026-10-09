-- 158: Award ceremony voting — strictly-sequential, anonymous, one-department-at-a-time.
--
-- Shape of a ceremony:
--   voting_departments      the ordered groups (FRO -> Digital -> Developers -> HR -> Admin -> Housekeeping)
--   voting_department_members  per-group membership override (include + exclude)
--   voting_sessions         one ceremony event
--   voting_turns            one scheduled turn per group per session, carrying the open/close window
--   voting_ballots          the votes themselves
--   voting_audit            who pressed which HR control button (NOT who voted)
--
-- Anonymity
--   voting_ballots deliberately has NO voter identity column. A ballot stores only
--   the nominee plus `voter_hash` = HMAC(secret, turn_id + ':' + login_id), with
--   UNIQUE (turn_id, voter_hash). That is what makes a second vote impossible.
--   The hash is never returned by any endpoint and cannot be reversed, so no API
--   surface can ever show who voted for whom. voting_audit records ceremony
--   control actions only and is never joined to ballots.
--
-- Time
--   The server checks opens_at/closes_at itself on every read and write, so a
--   device with a wrong clock cannot vote early or vote late. Client countdowns
--   are cosmetic.

CREATE TABLE IF NOT EXISTS voting_departments (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  order_index      INT NOT NULL,
  match_department TEXT,
  -- When true, membership comes ONLY from voting_department_members and the
  -- match_department value is ignored. This is how a group like Developers is
  -- defined when `workers.department` has no matching value to key off.
  is_locked        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voting_department_members (
  id            SERIAL PRIMARY KEY,
  department_id INT NOT NULL REFERENCES voting_departments(id) ON DELETE CASCADE,
  worker_id     UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  -- TRUE  -> this person is removed from the group
  -- FALSE -> this person IS the group (and, when at least one FALSE row exists
  --          for a group, the group's roster becomes exactly the FALSE rows)
  is_excluded   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (department_id, worker_id)
);

CREATE TABLE IF NOT EXISTS voting_sessions (
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
);

CREATE TABLE IF NOT EXISTS voting_turns (
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
);

CREATE TABLE IF NOT EXISTS voting_ballots (
  id            BIGSERIAL PRIMARY KEY,
  session_id    INT NOT NULL REFERENCES voting_sessions(id) ON DELETE CASCADE,
  turn_id       INT NOT NULL REFERENCES voting_turns(id) ON DELETE CASCADE,
  department_id INT NOT NULL REFERENCES voting_departments(id) ON DELETE CASCADE,
  nominee_id    UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  voter_hash    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  -- One ballot per person per turn. This constraint IS the one-vote rule.
  UNIQUE (turn_id, voter_hash)
);

CREATE TABLE IF NOT EXISTS voting_audit (
  id         BIGSERIAL PRIMARY KEY,
  session_id INT REFERENCES voting_sessions(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  detail     TEXT,
  actor      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voting_departments_order ON voting_departments (order_index);
CREATE INDEX IF NOT EXISTS idx_voting_department_members_dept ON voting_department_members (department_id);
CREATE INDEX IF NOT EXISTS idx_voting_department_members_worker ON voting_department_members (worker_id);
CREATE INDEX IF NOT EXISTS idx_voting_turns_session ON voting_turns (session_id, order_index);
CREATE INDEX IF NOT EXISTS idx_voting_ballots_turn ON voting_ballots (turn_id);
CREATE INDEX IF NOT EXISTS idx_voting_ballots_nominee ON voting_ballots (nominee_id);
CREATE INDEX IF NOT EXISTS idx_voting_ballots_session_dept ON voting_ballots (session_id, department_id);
CREATE INDEX IF NOT EXISTS idx_voting_audit_session ON voting_audit (session_id, created_at);
