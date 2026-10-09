-- Module 7 — conversation status: the fourth value (resolved) plus the status
-- history table.
--
-- Two jobs, both idempotent:
--   1. Widen the existing CHECK on conversations.status from
--      ('open','pending','closed') to ('open','pending','resolved','closed').
--      The old constraint may have been auto-named by an older PostgreSQL, so
--      the block drops every CHECK on that column before re-adding one named
--      constraint. It runs only when 'resolved' is not yet allowed, so an
--      already-migrated database is left alone.
--   2. Create the history table used to answer "who moved this conversation,
--      and when".
--
-- Applied by db/migrate.js after schema.sql and re-applied at boot by
-- conversation.repository.js ensureStatusSchema(), so a database created
-- before Module 7 gains both without a manual step. No rows are deleted and
-- no existing value is rewritten: every pre-existing conversation stays valid.

DO $$
DECLARE
  existing RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'conversations'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%resolved%'
  ) THEN
    RETURN;
  END IF;

  FOR existing IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'conversations'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', existing.conname);
  END LOOP;

  ALTER TABLE conversations
    ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('open', 'pending', 'resolved', 'closed'));
END $$;

-- Append-only trail of status transitions. changed_by is NULL when the system
-- made the move (a new customer message reopening a resolved thread).
CREATE TABLE IF NOT EXISTS conversation_status_history (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  old_status TEXT NOT NULL CHECK (old_status IN ('open', 'pending', 'resolved', 'closed')),
  new_status TEXT NOT NULL CHECK (new_status IN ('open', 'pending', 'resolved', 'closed')),
  changed_by INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_status_history_conv_idx
  ON conversation_status_history (conversation_id, changed_at DESC);
