-- 121: Lead champion announcements table
-- Stores the daily announced champion (one per day, locked snapshot)

CREATE TABLE IF NOT EXISTS lead_champion_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_date DATE NOT NULL UNIQUE,
  fro_worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
  fro_name TEXT,
  total_leads INT DEFAULT 0,
  qualified_leads INT DEFAULT 0,
  total_amount NUMERIC(12,2) DEFAULT 0,
  lead_incentive NUMERIC(12,2) DEFAULT 0,
  slab_bonus NUMERIC(12,2) DEFAULT 0,
  champion_bonus NUMERIC(12,2) DEFAULT 0,
  total_incentive NUMERIC(12,2) DEFAULT 0,
  message TEXT,
  announced_by UUID REFERENCES workers(id) ON DELETE SET NULL,
  announced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_champion_date ON lead_champion_announcements(announcement_date);