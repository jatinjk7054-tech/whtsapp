-- 082: split bank_audit_sources into kinds — received-bank entries vs mode-of-payment entries.
--   kind='bank' → appears in "Received Bank" dropdowns (entry modal, receipt history, reports)
--   kind='mop'  → appears in the entry modal "Mode of Payment" dropdown
-- The same name is allowed to exist once per tab (UNIQUE moved from name → (name, kind)).
-- Seed: every pre-existing source is duplicated into the MOP tab so both tabs start
-- with the same set; prune unwanted rows via Manage Sources delete.

ALTER TABLE bank_audit_sources ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bank';

ALTER TABLE bank_audit_sources DROP CONSTRAINT IF EXISTS bank_audit_sources_name_key;
ALTER TABLE bank_audit_sources ADD CONSTRAINT bank_audit_sources_name_kind_key UNIQUE (name, kind);

INSERT INTO bank_audit_sources (name, kind, is_active, sort_order)
SELECT name, 'mop', is_active, sort_order
FROM bank_audit_sources
WHERE kind = 'bank'
ON CONFLICT (name, kind) DO NOTHING;
