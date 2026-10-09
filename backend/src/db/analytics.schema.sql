-- Module 8 — Agent Performance Analytics.
--
-- The analytics queries aggregate over conversations / messages. The four
-- status values and the message statuses already have support, and the
-- analytics queries are written so they only ever read the application
-- timezone from away_message_settings (fallback Asia/Kolkata) — the new
-- indexes below are the only schema change:
--
--   * messages (sent_by_staff_id, created_at)        messages-sent per agent
--   * messages (conversation_id, direction, ...)     response-time lookups
--   * conversations (status)                         status count aggregation
--
-- `CREATE INDEX IF NOT EXISTS` makes this safe to run on every boot and from
-- `npm run db:migrate`; no data is touched.
CREATE INDEX IF NOT EXISTS messages_staff_created_idx
  ON messages (sent_by_staff_id, created_at);

CREATE INDEX IF NOT EXISTS conversations_status_idx
  ON conversations (status);

CREATE INDEX IF NOT EXISTS messages_conversation_direction_idx
  ON messages (conversation_id, direction, created_at, id);