-- 110: Remove duplicate seed records from the reminders table.
--
-- Migration 109 (valid_reminder_seed_data) had no idempotency guard, so if it was
-- run more than once each seed row was inserted again, doubling the total count
-- (e.g. 64 rows became 128). This migration deletes every duplicate row that shares
-- the same (title, category, owner, due_date_display, renewal_date_display, notes),
-- keeping only the lowest id for each unique set.
--
-- Run this ONCE against the production database.

DELETE FROM reminders a
USING reminders b
WHERE a.id > b.id
  AND COALESCE(a.title, '') = COALESCE(b.title, '')
  AND COALESCE(a.category, '') = COALESCE(b.category, '')
  AND COALESCE(a.owner, '') = COALESCE(b.owner, '')
  AND COALESCE(a.due_date_display, '') = COALESCE(b.due_date_display, '')
  AND COALESCE(a.renewal_date_display, '') = COALESCE(b.renewal_date_display, '')
  AND COALESCE(a.notes, '') = COALESCE(b.notes, '');

-- Optional: prevent future duplicates by adding a unique constraint on the seed fields.
-- Uncomment only after the dedupe above has run successfully:
-- ALTER TABLE reminders ADD CONSTRAINT reminders_title_category_owner_dates_key
--   UNIQUE (title, category, owner, due_date_display, renewal_date_display, notes);
