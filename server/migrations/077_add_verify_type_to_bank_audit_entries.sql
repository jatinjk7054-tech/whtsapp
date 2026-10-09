-- Migration 077: Add verify_type and verify_fro_worker_id to bank_audit_entries
-- These columns persist the Manual Verify form's Type (FRO/Library/PG) and selected
-- FRO worker so the form can be pre-filled when reopened.

ALTER TABLE bank_audit_entries ADD COLUMN IF NOT EXISTS verify_type VARCHAR(20);
ALTER TABLE bank_audit_entries ADD COLUMN IF NOT EXISTS verify_fro_worker_id VARCHAR;
