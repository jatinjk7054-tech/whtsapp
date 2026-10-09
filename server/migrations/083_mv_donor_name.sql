-- 083: dedicated field for the Donor Name typed into the Manual Verify modal.
--   bank_audit_entries.payer_name stays the immutable bank-statement name;
--   mv_donor_name holds what Accounts typed so reopening the MV form prefills
--   it (no retyping) without ever touching the statement name.

ALTER TABLE bank_audit_entries ADD COLUMN IF NOT EXISTS mv_donor_name text;
