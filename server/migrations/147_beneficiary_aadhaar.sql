-- 147: Beneficiary Aadhaar scraper.
-- Stores the Aadhaar number captured when the operator scans the Aadhaar QR
-- on the beneficiaries mobile app registration form. Idempotent: safe to re-run.
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS aadhaar_number TEXT;

CREATE INDEX IF NOT EXISTS idx_beneficiaries_aadhaar ON beneficiaries(aadhaar_number);