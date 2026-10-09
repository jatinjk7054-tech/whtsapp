-- 148: Beneficiaries kit catalog + organizers.
-- Name-only lists managed in Accounts > Beneficiaries > Programs ("Kits" and
-- "Organizers" buttons). The operator app shows them as dropdowns on the
-- Operator Details screen and stores the chosen values on the day's
-- assignment (operator_assignments). Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS bnf_kits (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bnf_organizers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE operator_assignments ADD COLUMN IF NOT EXISTS kit_id INT REFERENCES bnf_kits(id) ON DELETE SET NULL;
ALTER TABLE operator_assignments ADD COLUMN IF NOT EXISTS organizer_id INT REFERENCES bnf_organizers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bnf_kits_name ON bnf_kits (name);
CREATE INDEX IF NOT EXISTS idx_bnf_organizers_name ON bnf_organizers (name);