-- Audience voting: open-link rating of speakers on five criteria.
--
-- Deliberately separate from the award ceremony tables (voting_*). Those are
-- anonymous, login-gated, department-scoped and count one winner per team. This
-- feature is the opposite on every axis: anyone with the link rates a speaker,
-- the score is a five-criteria average rather than a head count, and there is no
-- ballot secrecy to preserve because the rater names themselves. Keeping them
-- apart means neither can be bent to behave like the other.
--
-- An event is a named session. Participants are queued up front and the admin
-- steps through them one at a time by moving `aud_vote_events.current_participant_id`;
-- the audience app polls that column and rates whoever is on stage.

CREATE TABLE IF NOT EXISTS aud_vote_events (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft',
  current_participant_id  INT,
  created_by              TEXT,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aud_vote_participants (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES aud_vote_events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Queue position, never rewritten once ratings exist. It is the order the
  -- admin set up, not the order people happened to speak in, so re-queueing
  -- mid-event cannot silently relabel an already-rated speaker.
  order_index INT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, order_index)
);

-- The FK is added after both tables exist (below) rather than inline, because
-- aud_vote_events.current_participant_id and aud_vote_participants.event_id are
-- mutually referential.

CREATE TABLE IF NOT EXISTS aud_vote_voters (
  id           SERIAL PRIMARY KEY,
  event_id     INT NOT NULL REFERENCES aud_vote_events(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- Not an identity claim: the audience app has no login, so this is a random
  -- UUID the server hands out on join. It exists to stop one phone submitting
  -- the same speaker twice by accident, and UNIQUE below is what enforces that.
  -- It is not a security control — clearing site storage defeats it by design.
  device_token UUID NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, device_token)
);

-- findVoterByDevice() looks a device up across ALL events, to carry a returning
-- audience member's name into the event that just started. Without this the
-- lookup can only use the (event_id, device_token) unique index, which cannot
-- serve a query with no event_id in it, and every first rating of a new session
-- degrades to a sequential scan as events accumulate.
CREATE INDEX IF NOT EXISTS idx_aud_vote_voters_device ON aud_vote_voters (device_token);

CREATE TABLE IF NOT EXISTS aud_vote_ratings (
  id             BIGSERIAL PRIMARY KEY,
  event_id       INT NOT NULL REFERENCES aud_vote_events(id) ON DELETE CASCADE,
  participant_id INT NOT NULL REFERENCES aud_vote_participants(id) ON DELETE CASCADE,
  voter_id       INT NOT NULL REFERENCES aud_vote_voters(id) ON DELETE CASCADE,
  -- Four star criteria, 1..5.
  delivery       SMALLINT NOT NULL CHECK (delivery BETWEEN 1 AND 5),
  confidence     SMALLINT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  clarity        SMALLINT NOT NULL CHECK (clarity BETWEEN 1 AND 5),
  relevance      SMALLINT NOT NULL CHECK (relevance BETWEEN 1 AND 5),
  -- Timing is a choice, not a star row, so it is stored as the score it maps to:
  -- before time = 1, beyond time = 3, on time = 5. Stored as the score rather
  -- than as a label so the average is one plain AVG() over all five columns and
  -- the criterion cannot be silently left out of the total.
  timing         SMALLINT NOT NULL CHECK (timing IN (1, 3, 5)),
  comment        TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  -- The one-rating-per-speaker guarantee, enforced by the database rather than
  -- by a read-then-write in the controller. Two taps, two tabs and a retried
  -- request all collapse to one rating.
  UNIQUE (participant_id, voter_id)
);

DO $$
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
END $$;

CREATE INDEX IF NOT EXISTS idx_aud_vote_participants_event
  ON aud_vote_participants (event_id, order_index);

CREATE INDEX IF NOT EXISTS idx_aud_vote_voters_event
  ON aud_vote_voters (event_id);

CREATE INDEX IF NOT EXISTS idx_aud_vote_ratings_participant
  ON aud_vote_ratings (participant_id);

-- The results screen aggregates every rating of one event, grouped by
-- participant. Without this it is a sequential scan of the whole table per
-- admin refresh, and the admin page polls while the event is live.
CREATE INDEX IF NOT EXISTS idx_aud_vote_ratings_event
  ON aud_vote_ratings (event_id, participant_id);