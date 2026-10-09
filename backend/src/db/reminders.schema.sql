-- Module 10 — Notifications & Follow-up Reminders.
--
-- Two independent concerns that share the same permission model as every other
-- conversation read (admin = everything, agent = only their own queue):
--
--   1. `reminders`      — follow-up tasks an agent/admin sets on a conversation.
--   2. `notifications`  — the per-staff notification feed behind the header bell.
--
-- This module adds NO agent-assignment behaviour: reminders reference the
-- existing conversation and never write conversations.assigned_staff_id.
--
-- Applied by db/migrate.js and re-applied idempotently at server start by
-- reminders/reminder.repository.js and notifications/notification.repository.js,
-- so an existing database gains Module 10 with no manual migration step. No
-- existing customer, message, conversation or staff row is ever touched.

-- Follow-up reminders. `due_at` is stored as TIMESTAMPTZ (UTC) and always shown
-- to the user in their own local timezone; Asia/Kolkata is the product default.
CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  -- The staff member who created the reminder; NULL only if that account is
  -- later deleted (the reminder itself is conversation data and is kept).
  created_by INTEGER REFERENCES staff (id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The Reminders dashboard reads pending reminders by due date first; completed
-- and cancelled rows are filtered by status.
CREATE INDEX IF NOT EXISTS reminders_status_due_idx
  ON reminders (status, due_at);

-- "Reminders for this conversation" (the conversation action) and the overdue /
-- due-today joins both walk this index.
CREATE INDEX IF NOT EXISTS reminders_conversation_idx
  ON reminders (conversation_id, due_at DESC);

-- Agent scope: "reminders I created" plus per-owner filtering.
CREATE INDEX IF NOT EXISTS reminders_created_by_idx
  ON reminders (created_by, status, due_at);

-- Per-staff notification feed. `dedupe_key` plus the unique index below is the
-- idempotency guard: Meta retrying a webhook, the frontend polling, or two
-- concurrent sweeps can never create the same notification twice.
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('new_message', 'reminder_due')),
  conversation_id INTEGER REFERENCES conversations (id) ON DELETE CASCADE,
  reminder_id INTEGER REFERENCES reminders (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  -- Stable, content-free identity for this (staff, event) pair, e.g.
  -- 'new_message:1234' or 'reminder_due:56'.
  dedupe_key TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_staff_dedupe_key
  ON notifications (staff_id, dedupe_key);

-- The bell reads unread-first, newest-first.
CREATE INDEX IF NOT EXISTS notifications_staff_feed_idx
  ON notifications (staff_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS notifications_staff_unread_idx
  ON notifications (staff_id)
  WHERE read_at IS NULL;
