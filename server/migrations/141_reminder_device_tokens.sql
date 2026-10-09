-- 141: Reminder mobile push — owner device tokens + alert dedupe log.
-- The Bill Reminder Flutter app (com.beingsevak.reminder) registers the
-- owner's FCM device tokens here; the reminder notification scheduler uses
-- reminder_alert_log to push each alert type at most once per day.

CREATE TABLE IF NOT EXISTS reminder_device_tokens (
  id bigserial PRIMARY KEY,
  token text UNIQUE NOT NULL,
  device_type text DEFAULT 'flutter',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminder_alert_log (
  id bigserial PRIMARY KEY,
  reminder_id bigint REFERENCES reminders(id) ON DELETE CASCADE,
  alert_type text,
  sent_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, alert_type, sent_date)
);

CREATE INDEX IF NOT EXISTS idx_reminder_alert_log_sent ON reminder_alert_log(sent_date);