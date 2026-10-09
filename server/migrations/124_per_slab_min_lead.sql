-- 124: Per-slab Minimum Lead Amount + per-slab ₹ per Qualified Lead.
-- Each incentive_slab row now carries its own qualification threshold and
-- per-lead reward, replacing the single global values for those two fields.

ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS min_lead_amount NUMERIC(12,2) NOT NULL DEFAULT 300;
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS lead_rate NUMERIC(12,2) NOT NULL DEFAULT 20;

-- Backfill existing rows that still have the old defaults (NULL / 0) with the
-- current global settings so existing slabs keep working.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM incentive_settings WHERE setting_key = 'min_lead_amount') THEN
    UPDATE incentive_slabs
       SET min_lead_amount = (SELECT setting_value FROM incentive_settings WHERE setting_key = 'min_lead_amount')
     WHERE min_lead_amount = 300;
  END IF;

  IF EXISTS (SELECT 1 FROM incentive_settings WHERE setting_key = 'lead_rate') THEN
    UPDATE incentive_slabs
       SET lead_rate = (SELECT setting_value FROM incentive_settings WHERE setting_key = 'lead_rate')
     WHERE lead_rate = 20;
  END IF;
END $$;
