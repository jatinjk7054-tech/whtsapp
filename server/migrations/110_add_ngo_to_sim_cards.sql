-- 110: Add NGO column to sim_cards for the SIM distribution modal.
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS ngo text;
