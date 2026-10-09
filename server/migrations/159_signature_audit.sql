-- Migration 159: Signature durability + audit trail.
--
-- A volunteer's signature used to reach the server only on the final form
-- submit. If they signed and then closed the tab, the signature was lost and HR
-- saw a blank line. The two-phase 'draft' -> 'signed' flow fixes that: the image
-- is persisted on Save Signature, and only the final submit locks it.
--
-- signature_status
--   'draft'  — captured and stored, still re-signable by the volunteer.
--   'signed' — committed. Re-signable only through the explicit "Update
--              signature" path (re_sign), which archives the old image into
--              signature_previous_url and re-stamps the record.
--   NULL     — never signed.
--
-- Print forms and generated letters must gate on 'signed' so a half-finished
-- draft is never printed onto a legal document.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_status     TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_signed_at  TIMESTAMPTZ;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_ip         TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_source     TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_policy_id  TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_previous_url TEXT;

-- Everything already uploaded counts as final. Without this backfill every
-- existing volunteer would suddenly read as "unsigned" in HR's completeness
-- stats and print with an empty signature line.
UPDATE workers
   SET signature_status = 'signed'
 WHERE signature_url IS NOT NULL
   AND signature_status IS NULL;

-- signature_signed_at is deliberately left NULL for these rows. Now() would be a
-- fabricated signing date. backend/scripts/backfill_signature_dates.mjs fills it
-- from the real S3 LastModified instead.
