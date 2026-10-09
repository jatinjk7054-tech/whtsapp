-- 106: SIM card edit history (audit trail of previous data).
-- Stores a snapshot of a SIM card's data BEFORE each edit so past values are retained.
-- Changed fields are captured as a JSON col { field: { old, new } }; full snapshot also saved.

CREATE TABLE IF NOT EXISTS sim_card_history (
  id bigserial PRIMARY KEY,
  sim_card_id bigint REFERENCES sim_cards(id) ON DELETE CASCADE,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_cols jsonb,
  before_data jsonb,
  after_data jsonb
);

CREATE INDEX IF NOT EXISTS idx_sim_card_history_card
  ON sim_card_history(sim_card_id);

CREATE INDEX IF NOT EXISTS idx_sim_card_history_changed_at
  ON sim_card_history(changed_at);