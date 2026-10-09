-- 105: Extend SIM slots from 8 to 20.
-- Adds sim_9 .. sim_20 columns to sim_cards so more than 8 SIMs can be stored per card.
-- Follows the existing sim_1..sim_8 pattern (text, nullable).

ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_9 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_10 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_11 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_12 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_13 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_14 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_15 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_16 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_17 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_18 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_19 text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS sim_20 text;