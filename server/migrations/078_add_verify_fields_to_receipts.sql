-- Migration 078: Add verify_type and verify_fro_worker_id to receipts
-- These columns persist the Manual Verify form's Type and selected FRO worker
-- for suspense receipts (which live in receipts, not bank_audit_entries).

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS verify_type VARCHAR(20);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS verify_fro_worker_id VARCHAR;
