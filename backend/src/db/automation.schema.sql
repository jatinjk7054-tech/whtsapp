-- Module 9 — Advanced WhatsApp Automation (keyword replies + logs).
--
-- This module adds NO agent-assignment behaviour of any kind. Conversations
-- keep their existing manual assignment and ownership rules; everything here
-- only decides whether an *automatic customer reply* is sent, and records what
-- happened. Applied by db/migrate.js and re-applied idempotently at server
-- start by automation/automation.repository.js ensureAutomationSchema(), so an
-- existing database gains Module 9 without a manual migration step.

-- One global, Admin-controlled automation configuration row (id pinned to 1).
CREATE TABLE IF NOT EXISTS automation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Master ON/OFF for keyword-based automatic replies. The Module 6 Away
  -- Message keeps its own toggle; this one gates the keyword engine only.
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- When false (default) an inbound message that already received an Away
  -- Message never also gets a keyword reply. An Admin may explicitly opt in.
  send_away_and_keyword BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keyword rules an Admin maintains. Matching is always case-insensitive; the
-- match type adds the optional exact / prefix / suffix / whole-word behaviour.
CREATE TABLE IF NOT EXISTS automation_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  keyword TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains'
    CHECK (match_type IN ('contains', 'exact', 'starts_with', 'ends_with', 'whole_word')),
  reply_text TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Optional customer tag applied when the rule fires (reuses the Module 5 tag
  -- catalogue; deleting a tag simply clears the reference).
  tag_id INTEGER REFERENCES tags (id) ON DELETE SET NULL,
  -- Higher priority wins. Ties are broken by id so the order is deterministic.
  priority INTEGER NOT NULL DEFAULT 0,
  -- Per-conversation cooldown. 0 means "no cooldown".
  cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0),
  -- Optional APPROVED WhatsApp template used only when the 24-hour customer
  -- care window is closed. Free-form replies are never sent outside it.
  template_name TEXT,
  template_language TEXT,
  created_by INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_rules_name_key
  ON automation_rules (LOWER(name));

CREATE INDEX IF NOT EXISTS automation_rules_enabled_idx
  ON automation_rules (enabled, priority DESC, id);

-- Per (conversation, rule) cooldown state. The primary key makes a concurrent
-- webhook burst race for exactly one claim, so a customer never receives two
-- copies of the same rule's reply. Row removed when the send itself fails so
-- the next genuine message can retry.
CREATE TABLE IF NOT EXISTS automation_rule_state (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  rule_id INTEGER NOT NULL REFERENCES automation_rules (id) ON DELETE CASCADE,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, rule_id)
);

-- Append-only audit trail. `detail` only ever carries human-readable context
-- and safe error messages — never access tokens, app secrets or credentials.
CREATE TABLE IF NOT EXISTS automation_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL CHECK (action IN ('keyword_reply', 'away_message')),
  result TEXT NOT NULL CHECK (result IN ('processing', 'sent', 'failed', 'skipped', 'blocked')),
  conversation_id INTEGER REFERENCES conversations (id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  -- The inbound message that triggered the automation.
  trigger_message_id INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  -- The outbound message that was produced (when a send was attempted).
  message_id INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  rule_id INTEGER REFERENCES automation_rules (id) ON DELETE SET NULL,
  rule_name TEXT,
  detail TEXT,
  wa_message_id TEXT
);

CREATE INDEX IF NOT EXISTS automation_logs_created_idx
  ON automation_logs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS automation_logs_rule_idx
  ON automation_logs (rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS automation_logs_action_idx
  ON automation_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS automation_logs_result_idx
  ON automation_logs (result, created_at DESC);

-- Duplicate-webhook guard: one keyword reply per (inbound message, rule). The
-- webhook_events / messages unique indexes already stop a redelivered wamid
-- from being processed twice; this is the automation-level backstop.
CREATE UNIQUE INDEX IF NOT EXISTS automation_logs_keyword_once
  ON automation_logs (trigger_message_id, rule_id)
  WHERE action = 'keyword_reply';
