-- 099: Allow 'holiday' in leaves.type.
--
-- The Flutter app and the backend /api/leaves/apply already support a 5th
-- leave type, 'holiday' (a range leave stored via start_date/end_date, exactly
-- like 'vacational'). But the live DB CHECK constraint leaves_type_chek only
-- allows full_day/half_day/vacational/emergency, so applying a holiday leave
-- fails with:
--   new row for relation "leaves" violates check constraint "leaves_type_chek"
--
-- This migration drops any CHECK constraint on leaves.type and recreates it
-- to include 'holiday'. It is idempotent: re-running it drops the freshly
-- added same-name constraint (its definition references "type") and recreates
-- the identical definition, so it is safe to run more than once.

DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'leaves'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE leaves DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE leaves ADD CONSTRAINT leaves_type_chek
  CHECK (type IN ('full_day', 'half_day', 'vacational', 'emergency', 'holiday'));