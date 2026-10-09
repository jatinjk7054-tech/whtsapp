-- 142: Record payment details (UPI transaction id + who marked paid).
-- Used by the "Mark as Paid" flow in the Bill Reminder panel / app.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS transaction_id text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS paid_by text;