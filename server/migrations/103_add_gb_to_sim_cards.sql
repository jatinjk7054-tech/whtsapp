-- 103: Add GB (device storage) column to sim_cards.
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS gb text;