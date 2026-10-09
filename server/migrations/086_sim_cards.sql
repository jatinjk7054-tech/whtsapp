-- 086: SIM Card management.
-- Tracks company SIM cards, devices, IMEI, expiry dates and replacement history.

CREATE TABLE IF NOT EXISTS sim_cards (
  id bigserial PRIMARY KEY,
  mobile_id text,
  device_model text,
  imei text,
  team text,
  signature text,
  issue_date date,
  expiry_date date,
  status text NOT NULL DEFAULT 'Active',
  sim_1 text,
  sim_2 text,
  sim_3 text,
  sim_4 text,
  sim_5 text,
  sim_6 text,
  sim_7 text,
  sim_8 text,
  replacement_count integer NOT NULL DEFAULT 0,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sim_card_replacements (
  id bigserial PRIMARY KEY,
  sim_card_id bigint REFERENCES sim_cards(id) ON DELETE CASCADE,
  replacement_date date NOT NULL,
  old_sim text,
  new_sim text NOT NULL,
  device text,
  reason text,
  new_expiry_date date,
  changed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sim_cards_expiry
  ON sim_cards(expiry_date);

CREATE INDEX IF NOT EXISTS idx_sim_cards_status
  ON sim_cards(status);

CREATE INDEX IF NOT EXISTS idx_sim_replacements_card
  ON sim_card_replacements(sim_card_id);
