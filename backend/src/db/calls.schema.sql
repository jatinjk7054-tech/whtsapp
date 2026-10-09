-- Module 12 — WhatsApp Business Calling (voice).
--
-- One row per call (inbound or outbound) plus an append-only event log that is
-- the idempotency gate for Meta's redelivered `calls` webhooks. No audio is ever
-- stored here — only signalling (SDP) and call metadata. SDP is a short-lived
-- offer/answer, not a recording, and it is only ever returned to the staff who
-- is authorised for the conversation.
--
-- Applied by db/migrate.js and re-applied idempotently at server start by
-- calls/call.repository.js, so an existing database gains Module 12 with no
-- manual migration step. Nothing here changes assignment or permissions.

-- Widen the notification vocabulary to allow a missed-call alert. Idempotent:
-- if the constraint already lists 'missed_call' the block returns untouched.
DO $$
DECLARE
  existing RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'notifications'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%missed_call%'
  ) THEN
    RETURN;
  END IF;

  FOR existing IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'notifications'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', existing.conname);
  END LOOP;

  ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('new_message', 'reminder_due', 'missed_call'));
END $$;

CREATE TABLE IF NOT EXISTS calls (
  id BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  -- Meta's call id (the `wacid...` from the Call Connect webhook). NULL until
  -- the first webhook/accept arrives for an outbound call.
  wa_call_id TEXT,
  -- Our own opaque reference, echoed back by Meta on every event for this call.
  -- This is what lets an outbound call be matched to its row before the wacid
  -- is known, and it is what the frontend polls.
  client_ref TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL DEFAULT 'initiating'
    CHECK (status IN ('initiating', 'ringing', 'connecting', 'connected', 'ended', 'missed', 'failed')),
  -- Signalling only; replaced by Meta's answer for outbound, carried in by the
  -- Call Connect webhook for inbound. Never a recording.
  sdp_offer TEXT,
  sdp_answer TEXT,
  initiated_by_staff_id INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  answered_by_staff_id INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  end_reason TEXT,
  error_code INTEGER,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per Meta call id: duplicate Call Connect webhooks cannot fork a call.
-- Postgres keeps NULLs distinct, so the many not-yet-known outbound calls are
-- fine; ON CONFLICT (wa_call_id) can infer this index directly.
CREATE UNIQUE INDEX IF NOT EXISTS calls_wa_call_id_key
  ON calls (wa_call_id);

-- Our own correlation key, unique so a retried `connect` send reuses its row.
CREATE UNIQUE INDEX IF NOT EXISTS calls_client_ref_key
  ON calls (client_ref);

-- Conversation history (newest first) and the "active call for this thread" probe.
CREATE INDEX IF NOT EXISTS calls_conversation_idx
  ON calls (conversation_id, created_at DESC);

-- Polling for incoming ringing calls, plus the stale-call sweeper.
CREATE INDEX IF NOT EXISTS calls_status_idx
  ON calls (status, direction, created_at);

-- Append-only log of every processed call event. The unique `dedupe_key` is the
-- idempotency gate, matching the webhook_events / message_status_events pattern:
-- Meta retries until it gets a 200, so the same event can arrive many times.
CREATE TABLE IF NOT EXISTS call_events (
  id BIGSERIAL PRIMARY KEY,
  -- '<wacid|client_ref>:<event|status>:<timestamp>' — stable and content-free.
  dedupe_key TEXT NOT NULL UNIQUE,
  wa_call_id TEXT,
  client_ref TEXT,
  event TEXT NOT NULL,
  -- A small, sanitized copy of the event (never the whole envelope), so no
  -- customer content or token can land here.
  payload JSONB,
  call_id BIGINT REFERENCES calls (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS call_events_call_idx
  ON call_events (call_id, created_at DESC);
