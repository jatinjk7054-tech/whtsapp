CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_email_key ON staff (LOWER(email));

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  -- WhatsApp address (E.164, e.g. 919876543210). Not the display name.
  wa_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  -- Internal-only CRM data; never included in WhatsApp send payloads.
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Module 1: internal-only fields. `notes` is CRM data and is never included in
-- any WhatsApp send payload, so it can never reach the customer. `tags` is a
-- simple label list on the contact itself. The ALTERs upgrade databases that
-- were created before these columns existed.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  assigned_staff_id INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  -- Module 7: one canonical status column, four values.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  -- Denormalised so the inbox list never has to aggregate over messages.
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_preview TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A contact may have several threads over time but only one live (non-closed)
-- conversation at a time. Without this, two racing webhooks would fork the thread.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_open_per_contact
  ON conversations (contact_id)
  WHERE status <> 'closed';

CREATE INDEX IF NOT EXISTS conversations_assigned_idx
  ON conversations (assigned_staff_id, status, last_message_at DESC);

CREATE INDEX IF NOT EXISTS conversations_last_message_idx
  ON conversations (last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- 'received' for inbound. Outbound walks pending -> sent -> delivered -> read,
  -- or -> failed. Keeps the raw provider state for the UI. ('queued' is the
  -- legacy spelling of 'pending', kept in the CHECK for old rows.)
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'pending', 'queued', 'sent', 'delivered', 'read', 'failed')),
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '',
  -- Set once the provider returns an id (inbound immediately, outbound on accept).
  wa_message_id TEXT,
  media_url TEXT,
  error_code INTEGER,
  error_detail TEXT,
  -- Staff who pressed send, for audit and "mine vs theirs" filtering.
  sent_by_staff_id INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  -- Set when a staff member opens the thread. Drives the unread badge.
  read_at TIMESTAMPTZ,
  -- Module 3: reply reference (local FK for the quoted preview + the raw wamid
  -- exactly as WhatsApp supplied it, kept even when the original is unknown).
  reply_to_id INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  reply_to_wa_message_id TEXT,
  -- Module 3: set on messages sent through the Forward action.
  is_forwarded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Module 3: upgrade databases created before these columns existed.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages (id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_wa_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE;

-- Module 4: what an approved Meta template send actually contained, so the chat
-- can show the real sent text (variables filled in), the exact language code and
-- the parameters used. Never carries credentials — only the values the agent typed.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_language TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_params JSONB;

-- Server-side message search orders by recency across a scope.
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at DESC);

-- Doubles as the idempotency key: Meta redelivers webhooks, and we must not
-- create the same inbound message twice.
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_message_id_key
  ON messages (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  wa_message_id TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_completed_idx ON tasks (completed);

-- Module 5 (customer tags) lives in tags.schema.sql, applied right after this
-- file because contact_tags references contacts.