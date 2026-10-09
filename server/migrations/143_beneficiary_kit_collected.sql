-- 143: Beneficiary kit collection tracking.
-- Marks a beneficiary as having collected their kit (set from the operator
-- fingerprint flow). Idempotent: safe to re-run.
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS kit_collected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS kit_collected_at TIMESTAMPTZ;
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS kit_collected_by TEXT;