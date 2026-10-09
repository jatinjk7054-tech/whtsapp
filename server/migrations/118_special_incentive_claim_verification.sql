-- Migration 118: Special incentive ("Sir ka Incentive") prize verification flow.
-- Accounts uploads a photo of the FRO + hard cash received to prove the payout,
-- marking the winning incentive as verified/claimed.
--   claim_status   — 'pending' (default for won) | 'verified'
--   claim_photo_url— public storage URL of the FRO + cash photo
--   claimed_by     — worker id of the accounts user who verified
--   claimed_at     — when the prize was verified/claimed
--   claim_remarks  — optional note
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS claim_status text DEFAULT 'pending';
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS claim_photo_url text;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS claimed_by bigint;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS claim_remarks text;
