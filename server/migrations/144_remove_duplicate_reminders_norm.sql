-- 144: Remove duplicate reminder rows introduced by re-run imports / migrations.
--
-- Migration 110 only removed exact copies (title, category, owner, due date
-- display, renewal date display, notes all identical). Rows that describe the
-- same reminder but differ slightly (extra spaces, case, or display text) were
-- left behind, so the same bill appears multiple times (e.g. in "Website
-- Services" / OTHER_BILL groups).
--
-- This deletes every duplicate that shares the same normalized
-- (title, category, owner) — compared case-insensitively with collapsing
-- whitespace — keeping only the lowest id, matching the dedupe now applied
-- in getAllReminders() and the web client.
--
-- Run this ONCE against the production database.

DELETE FROM reminders a
USING reminders b
WHERE a.id > b.id
  AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(a.title, '')), '\s+', ' ', 'g'))
    = LOWER(REGEXP_REPLACE(TRIM(COALESCE(b.title, '')), '\s+', ' ', 'g'))
  AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(a.category, '')), '\s+', ' ', 'g'))
    = LOWER(REGEXP_REPLACE(TRIM(COALESCE(b.category, '')), '\s+', ' ', 'g'))
  AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(a.owner, '')), '\s+', ' ', 'g'))
    = LOWER(REGEXP_REPLACE(TRIM(COALESCE(b.owner, '')), '\s+', ' ', 'g'));

-- Optional: after a successful run, harden against future duplicates by
-- adding a unique partial index on the normalized identity fields.
-- Requires the uuid-ossp / pgcrypto extension only if you use lower() on id;
-- here we simply index the normalized fields to backfills/checks:
-- CREATE UNIQUE INDEX reminders_norm_identity_key
--   ON reminders (LOWER(REGEXP_REPLACE(TRIM(COALESCE(title,'')), '\s+', ' ', 'g')),
--                 LOWER(REGEXP_REPLACE(TRIM(COALESCE(category,'')), '\s+', ' ', 'g')),
--                 LOWER(REGEXP_REPLACE(TRIM(COALESCE(owner,'')), '\s+', ' ', 'g')))
--   WHERE is_deleted = false;