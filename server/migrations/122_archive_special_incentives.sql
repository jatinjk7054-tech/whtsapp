-- 122: Archive special (Sir ka) incentives.
-- Once archived, an incentive is excluded from the live/active payload, the
-- recent-closed winner celebration, and the winner-photo celebration, so its
-- popups stop appearing on every panel for good.

ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES workers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_special_incentives_archived_at ON special_incentives (archived_at);