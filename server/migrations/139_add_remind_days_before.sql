-- 139: Add "remind/renew N days before due date" lead time to reminders.
-- renewal_date is derived as due_date - remind_days_before.

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS remind_days_before integer;