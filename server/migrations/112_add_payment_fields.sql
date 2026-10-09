-- 112: Add payment amount and paid_at timestamp to reminders.
-- When a bill is marked as paid, amount records how much was paid
-- and paid_at records the exact date/time of payment.

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS amount numeric;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
