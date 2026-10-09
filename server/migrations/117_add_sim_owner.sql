-- 117: Add owner column to sim_cards for the Nokia Owner field.

ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS owner text;