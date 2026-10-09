-- 132: Lead champion celebration (winner photo + published congrats popup)
-- Lets Super Admin attach a winner photo + congratulation message to a
-- lead_champion_announcements row and publish it once (celebrated_at).
-- Published celebrations pop up on every panel exactly once per user.
ALTER TABLE lead_champion_announcements
  ADD COLUMN IF NOT EXISTS winner_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS celebrated_at TIMESTAMPTZ;
