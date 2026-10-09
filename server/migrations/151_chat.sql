-- Community Chat (plan.md §3)
--
-- One seeded group room ('community') plus 1:1 DMs created on demand.
--
-- Two identity columns on chat_participants, deliberately:
--   uid        - stable chat identity. Email for accounts users, login:<uuid> for
--                FRO/recruiters whose `users` rows carry no email. See plan.md §4.
--   subject_id - String(users.id), which is what notification_log.worker_id stores
--                and what SuperAdminPanel.jsx filters desktop notifications on.
--                Kept separate so a re-keyed login never orphans notifications.
--
-- Reads are authorized by the presence of a chat_participants row, never by role,
-- so adding a role later cannot accidentally widen DM visibility.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'group'   CHECK (kind IN ('group', 'direct')),
  slug        TEXT UNIQUE NOT NULL,            -- 'community' | 'dm:<uidA>|<uidB>' (sorted)
  title       TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS chat_participants (
  conversation_id   BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  uid               TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  role              TEXT NOT NULL,
  can_post          BOOLEAN NOT NULL DEFAULT false,
  display_name      TEXT NOT NULL,
  email             TEXT,
  ngo_id            TEXT,
  last_read_at      TIMESTAMPTZ,
  last_read_msg_id  BIGINT,
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_uid ON chat_participants (uid);
-- Unread badge counts walk (uid, conversation_id); this keeps that off a seq scan.
CREATE INDEX IF NOT EXISTS idx_chat_participants_uid_conv
  ON chat_participants (uid, conversation_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_uid      TEXT NOT NULL,
  sender_role     TEXT NOT NULL,
  sender_name     TEXT NOT NULL,
  body            TEXT,
  attachment_url  TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  attachment_size BIGINT,
  client_id       TEXT,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last-resort backstop for empty messages. The controller validates first and
  -- returns a friendly 400; this only fires if a future code path forgets to.
  CONSTRAINT chat_messages_has_content CHECK (
    (body IS NOT NULL AND length(body) > 0) OR attachment_url IS NOT NULL
  )
);

-- Primary access pattern: newest-first page for one conversation.
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, id DESC);
-- client_id reconciliation: the 201 response and the realtime event can race, and
-- the client matches the optimistic bubble on (conversation_id, client_id).
-- Partial, because client_id is null for everyone not mid-send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client
  ON chat_messages (conversation_id, client_id)
  WHERE client_id IS NOT NULL;
-- Search is ILIKE '%q%' (plan.md §3). A trigram index pays for itself once the
-- table passes a few thousand rows; at current volume a range scan is fine, so
-- this is left off deliberately rather than carrying write amplification.

-- ---------------------------------------------------------------------------
-- Repair: make the content check deletion-aware.
--
-- The constraint above was written for the INSERT path only, but soft delete
-- nulls both body and attachment_url, so it violates its own constraint and
-- every delete of a text-only message fails with a 500. A deleted row is
-- exactly the case where having no content is correct, so deleted_at is
-- exempted.
--
-- Written as DROP + ADD rather than editing the CREATE TABLE, because
-- CREATE TABLE IF NOT EXISTS does not re-run for a table that already exists,
-- so a database created before this fix would keep the broken constraint. This
-- is idempotent, and ensureChatSchema replays the whole file on every boot.
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_has_content;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_has_content CHECK (
  deleted_at IS NOT NULL
  OR (body IS NOT NULL AND length(body) > 0)
  OR attachment_url IS NOT NULL
);
