-- Migration 160: support selecting more than one document.
--
-- documents_value (migration 137) began as a single value and is now a JSON array
-- string, e.g. ["10th","Degree"]. Legacy single values such as "12th" are still
-- read correctly by the parser, so no data backfill is required.
--
-- The name a volunteer types for the "Other" option lives here, separately, so
-- that unticking "Other" cannot leave a stale custom name behind.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS documents_other TEXT;
