-- Module 6 — Away Message settings + Quick Replies.
--
-- One global, Admin-controlled away-message row (id is pinned to 1 so settings
-- can never be duplicated per agent) and a shared quick-reply library that
-- agents read and only admins edit.
--
-- Applied by db/migrate.js after schema.sql and re-applied idempotently at
-- server start by away.repository.js ensureAwaySettings(), so a database
-- migrated before Module 6 still gets the tables.

CREATE TABLE IF NOT EXISTS away_message_settings (
  -- Single-row table: the CRM has one global away message, not one per agent.
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Admin-editable copy. Never hardcoded at send time: the webhook reads this.
  message TEXT NOT NULL DEFAULT
    'Thank you for contacting Being Sevak Charitable Trust.
Our team is currently unavailable.
We will get back to you as soon as possible.',
  -- IANA zone (e.g. Asia/Kolkata) used to decide "now" for the schedule.
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- [{ "day": 0..6 (0 = Sunday), "enabled": true, "from": "09:00", "to": "18:00" }]
  schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  -- Shortcut the agent types/searches, stored with its leading "/".
  shortcut TEXT NOT NULL,
  -- Free label (Greeting, Donation, Follow-up, Support, General, ...).
  category TEXT NOT NULL DEFAULT 'General',
  message TEXT NOT NULL,
  -- Staff member who created it. NULL when the creator account is removed.
  created_by INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "/donation" can only exist once, whatever the case.
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_shortcut_key
  ON quick_replies (LOWER(shortcut));

-- Cooldown for the automatic away reply: one away message per customer per
-- 24 hours, stored in the database (not the browser).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_away_sent_at TIMESTAMPTZ;

-- Module 9: public holidays / closed days as an array of 'YYYY-MM-DD' strings.
-- A holiday counts as a non-office day, so the Away Message fires on it exactly
-- like an out-of-hours window. Reuses the existing Away Message configuration
-- rather than adding a second business-hours feature.
ALTER TABLE away_message_settings
  ADD COLUMN IF NOT EXISTS holidays JSONB NOT NULL DEFAULT '[]'::jsonb;
