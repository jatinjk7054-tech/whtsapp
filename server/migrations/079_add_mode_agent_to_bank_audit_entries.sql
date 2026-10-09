ALTER TABLE bank_audit_entries ADD COLUMN IF NOT EXISTS mode TEXT;
ALTER TABLE bank_audit_entries ADD COLUMN IF NOT EXISTS agent_name TEXT;
