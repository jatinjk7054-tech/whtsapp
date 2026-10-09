-- 088: SIM Inventory (physical SIM stock).
-- Tracks physical SIM cards held in stock, separately from the sim_cards
-- device records table. SIM Number is the primary business identifier.

CREATE TABLE IF NOT EXISTS sim_inventory (
  id bigserial PRIMARY KEY,
  sim_number text NOT NULL UNIQUE,
  sim_type text,
  provider text,
  status text NOT NULL DEFAULT 'Available',
  location text,
  mobile_id text,
  device text,
  imei text,
  assigned_to text,
  team text,
  assignment_date date,
  issue_date date,
  expiry_date date,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sim_inventory_status
  ON sim_inventory(status);

CREATE INDEX IF NOT EXISTS idx_sim_inventory_sim_number
  ON sim_inventory(sim_number);

CREATE INDEX IF NOT EXISTS idx_sim_inventory_expiry
  ON sim_inventory(expiry_date);
