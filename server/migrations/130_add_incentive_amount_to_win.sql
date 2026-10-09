-- Flat-prize lead incentive: each range now has a "Win On (₹)" target — the
-- total verified day collection a FRO must reach (by verified_at) to win the
-- range's flat prize (incentive_amount). Replaces the per-lead qualification
-- (min_lead_amount / lead_rate) model. min_lead_amount / lead_rate stay in the
-- DB (dormant) so older code doesn't break; every verified lead now counts.
ALTER TABLE incentive_slabs
  ADD COLUMN IF NOT EXISTS amount_to_win NUMERIC(12,2) NOT NULL DEFAULT 1500;