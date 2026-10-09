-- 119: Lead-based slab incentive tables
-- incentive_slabs: configurable target ranges + incentive amounts
-- incentive_settings: global lead calculation rules (rate, min amount, champion bonus)

CREATE TABLE IF NOT EXISTS incentive_slabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  min_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  incentive_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incentive_settings (
  id SERIAL PRIMARY KEY,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incentive_slabs_active ON incentive_slabs(is_active);
CREATE INDEX IF NOT EXISTS idx_incentive_settings_key ON incentive_settings(setting_key);

-- Seed default global settings
INSERT INTO incentive_settings (setting_key, setting_value) VALUES
  ('lead_rate', 20),
  ('min_lead_amount', 300),
  ('champion_bonus', 250)
ON CONFLICT (setting_key) DO NOTHING;

-- Seed 6 default slabs
INSERT INTO incentive_slabs (min_amount, max_amount, incentive_amount) VALUES
  (1, 20000, 0),
  (20000, 50000, 500),
  (50000, 80000, 1000),
  (80000, 135000, 2000),
  (135000, 200000, 3500),
  (200000, 350000, 5000);
