-- 145: Beneficiary kit "given" tracking.
-- Terminological rename: the NGO gives the kit TO the beneficiary, it is not
-- "collected" by them. Adds kit_given* columns, backfills from the old
-- kit_collected* values, then drops the old columns. Idempotent: safe to re-run.
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS kit_given BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS kit_given_at TIMESTAMPTZ;
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS kit_given_by TEXT;

-- Backfill existing history (only rows not already migrated).
UPDATE beneficiaries
SET kit_given = COALESCE(kit_given, kit_collected),
    kit_given_at = COALESCE(kit_given_at, kit_collected_at),
    kit_given_by = COALESCE(kit_given_by, kit_collected_by)
WHERE kit_given_at IS NULL
  AND kit_collected_at IS NOT NULL;

ALTER TABLE beneficiaries DROP COLUMN IF EXISTS kit_collected;
ALTER TABLE beneficiaries DROP COLUMN IF EXISTS kit_collected_at;
ALTER TABLE beneficiaries DROP COLUMN IF EXISTS kit_collected_by;