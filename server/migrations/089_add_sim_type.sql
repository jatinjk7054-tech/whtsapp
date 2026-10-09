-- 089: Add sim_type to sim_cards.
-- Prepaid / Postpaid classification for registered SIM cards.

ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_type text;
