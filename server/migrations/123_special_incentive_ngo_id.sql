-- 123: NGO-wise "Sir ka" incentives.
-- Each special incentive can now target a single NGO, so its collection window
-- counts only that NGO's fro_donor_logs (joined through fro_assignments) and
-- only that NGO's FROs (from fro_station_assignments) are seeded/seen. NULL =
-- legacy org-wide incentive (counts all NGOs, all FROs).

ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS ngo_id UUID REFERENCES ngos(id);

CREATE INDEX IF NOT EXISTS idx_special_incentives_ngo_id ON special_incentives (ngo_id);