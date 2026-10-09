-- Team-wise award voting: one pick per worker team per ballot.
--
-- A department ballot used to be a single row per voter, which made one pick for
-- the whole department. Now the team is the unit of choice — a voter picks one
-- person from each team on that department's ballot, so the ballot is stored as
-- one row per team.
--
-- `team_key` is the normalised team (trimmed, lower-cased) that was on the
-- nominee when the ballot was cast. It is a snapshot rather than a join to
-- workers.team on purpose: a team edit after the vote must not move an old
-- ballot into a different team. A blank team is stored as '' — the single
-- fallback group — rather than NULL, because UNIQUE treats every NULL as
-- distinct and would then let the same voter pick the no-team group repeatedly.

ALTER TABLE voting_ballots
  ADD COLUMN IF NOT EXISTS team_key TEXT NOT NULL DEFAULT '';

-- Existing ballots were one pick for the whole department. Attribute each to
-- the team its nominee sits in today; the snapshot cannot be recovered more
-- accurately than this, and rewriting history is worse than a stale key.
UPDATE voting_ballots b
   SET team_key = lower(btrim(COALESCE(w.team, '')))
  FROM workers w
 WHERE w.id = b.nominee_id
   AND b.team_key = '';

-- The old constraint is what made a second vote impossible; the new one stops a
-- second pick for the same team while allowing the other teams on that ballot.
--
-- It is found by its columns rather than by name, because the constraint that
-- 158_voting.sql created was unnamed and so carries a generated name. Leaving it
-- in place is not a soft failure: every ballot for a department with more than
-- one team would be rejected on its second row. Hence the explicit lookup.
DO $$
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
END $$;

DO $$
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
END $$;

-- The booth's "have I voted here yet?" check reads by (turn_id, voter_hash).
CREATE INDEX IF NOT EXISTS idx_voting_ballots_turn_voter
  ON voting_ballots (turn_id, voter_hash);