-- 124: Per-range lead incentive config
-- Qualified-lead rules move from global (incentive_settings) onto each
-- target range (incentive_slabs): each slab gets its own Minimum Lead Amount
-- and ₹ per Qualified Lead. Global values remain as fallback only.
ALTER TABLE incentive_slabs
  ADD COLUMN IF NOT EXISTS min_lead_amount NUMERIC(12,2) NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS lead_rate NUMERIC(12,2) NOT NULL DEFAULT 20;

-- Backfill existing slabs from the old global settings if present
UPDATE incentive_slabs
SET
  min_lead_amount = COALESCE(
    (SELECT setting_value FROM incentive_settings WHERE setting_key = 'min_lead_amount'),
    300
  ),
  lead_rate = COALESCE(
    (SELECT setting_value FROM incentive_settings WHERE setting_key = 'lead_rate'),
    20
  );