-- Module 11 — WhatsApp message delivery & read receipts.
--
-- Outbound messages walk a single provider state machine:
--   pending -> sent -> delivered -> read, or -> failed
-- ('pending' is the row we write before Meta answers; 'sent' is stored when Meta
-- echoes our wamid back; 'delivered' / 'read' / 'failed' come from the status
-- webhook.)  Nothing here changes assignment, ownership or permissions.
--
-- Applied by db/migrate.js and re-applied idempotently at server start by
-- conversations/message.repository.js, so an existing database gains Module 11
-- with no manual migration step. Existing inbound rows keep status 'received'.

-- The original CHECK only knew 'queued', so widen it and keep both spellings
-- ('queued' is migrated to 'pending' below but is left allowed so a very old row
-- restored from a backup can never fail to insert).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('received', 'pending', 'queued', 'sent', 'delivered', 'read', 'failed'));

-- Normalise the old transient label. Idempotent: only touches rows still on it.
UPDATE messages SET status = 'pending' WHERE status = 'queued';

-- Receipt timestamps. `messages.read_at` is unrelated — it records when a *staff*
-- member opened the thread, not when the customer read an outbound message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_receipt_at TIMESTAMPTZ;

-- Every delivery-status webhook Meta sends, one row per distinct event.
--
-- Meta redelivers webhooks and can send the same status twice, and the three
-- receipt statuses share one wamid, so the unique key is the composite
-- `dedupe_key`, not the wamid. A row that cannot be matched to a local message
-- yet (the receipt can race the `sent` write) is kept `applied_at IS NULL` and
-- retried by reconcileStatusEvents().
CREATE TABLE IF NOT EXISTS message_status_events (
  id BIGSERIAL PRIMARY KEY,
  -- '<wamid>:<status>:<event timestamp>' — stable, content-free, credential-free.
  dedupe_key TEXT NOT NULL UNIQUE,
  wa_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  event_timestamp TIMESTAMPTZ,
  error_code INTEGER,
  error_detail TEXT,
  -- A small, sanitized copy of the status object (never the whole envelope, so
  -- no customer content or token can land here).
  payload JSONB,
  matched_message_id INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reconciliation scans only the still-unmatched events.
CREATE INDEX IF NOT EXISTS message_status_events_unmatched_idx
  ON message_status_events (created_at)
  WHERE applied_at IS NULL;

CREATE INDEX IF NOT EXISTS message_status_events_message_idx
  ON message_status_events (matched_message_id);
