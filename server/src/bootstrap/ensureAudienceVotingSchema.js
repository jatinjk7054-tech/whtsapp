import db from '../config/db.js';

// Audience voting — open-link, five-criteria rating of speakers.
//
// Mirrors the shape of 162_audience_voting.sql so an install whose database was
// never migrated still boots into a working feature. CREATE TABLE IF NOT EXISTS
// is a no-op once the tables exist, and every index is IF NOT EXISTS, so this is
// idempotent and safe to run on every boot.
//
// Nothing is seeded: an event is created from the admin panel, not by the server.
// There is deliberately no default event, because a live event with an empty
// participant list would look like a broken booth to anyone holding the link.

async function ensureTables() {
  await db._pool.query(`CREATE TABLE IF NOT EXISTS aud_vote_events (
    id                      SERIAL PRIMARY KEY,
    name                    TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'draft',
    current_participant_id  INT,
    created_by              TEXT,
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS aud_vote_participants (
    id          SERIAL PRIMARY KEY,
    event_id    INT NOT NULL REFERENCES aud_vote_events(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    order_index INT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (event_id, order_index)
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS aud_vote_voters (
    id           SERIAL PRIMARY KEY,
    event_id     INT NOT NULL REFERENCES aud_vote_events(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    device_token UUID NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (event_id, device_token)
  )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS aud_vote_ratings (
    id             BIGSERIAL PRIMARY KEY,
    event_id       INT NOT NULL REFERENCES aud_vote_events(id) ON DELETE CASCADE,
    participant_id INT NOT NULL REFERENCES aud_vote_participants(id) ON DELETE CASCADE,
    voter_id       INT NOT NULL REFERENCES aud_vote_voters(id) ON DELETE CASCADE,
    delivery       SMALLINT NOT NULL CHECK (delivery BETWEEN 1 AND 5),
    confidence     SMALLINT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
    clarity        SMALLINT NOT NULL CHECK (clarity BETWEEN 1 AND 5),
    relevance      SMALLINT NOT NULL CHECK (relevance BETWEEN 1 AND 5),
    timing         SMALLINT NOT NULL CHECK (timing IN (1, 3, 5)),
    comment        TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (participant_id, voter_id)
  )`);

  // Mutual reference between events and participants, added after both tables
  // exist. ON DELETE SET NULL so removing the speaker currently on stage leaves
  // the event row intact instead of cascading it away.
  await db._pool.query(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
         WHERE c.conrelid = 'aud_vote_events'::regclass
           AND c.contype = 'f'
      ) THEN
        ALTER TABLE aud_vote_events
          ADD CONSTRAINT aud_vote_events_current_participant_fkey
          FOREIGN KEY (current_participant_id)
          REFERENCES aud_vote_participants(id) ON DELETE SET NULL;
      END IF;
    END $$`);

  const steps = [
    `CREATE INDEX IF NOT EXISTS idx_aud_vote_participants_event ON aud_vote_participants (event_id, order_index)`,
    `CREATE INDEX IF NOT EXISTS idx_aud_vote_voters_event ON aud_vote_voters (event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_aud_vote_ratings_participant ON aud_vote_ratings (participant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_aud_vote_ratings_event ON aud_vote_ratings (event_id, participant_id)`,
    // Not the same as idx_aud_vote_voters_event: findVoterByDevice() has no
    // event_id to filter on, because it deliberately searches every event to
    // carry a returning audience member's name into the one now running.
    `CREATE INDEX IF NOT EXISTS idx_aud_vote_voters_device ON aud_vote_voters (device_token)`,
  ];

  for (const sql of steps) {
    await db._pool.query(sql);
  }
}

export async function ensureAudienceVotingSchema() {
  await ensureTables();
}