-- Remove receipt numbers for bank entries created 2026-08-11.
-- Keeps all bank_audit_entries rows; drops their linked receipt records
-- and the entry-side copy of the receipt number.
BEGIN;

-- 1) Count what will be removed (sanity check before the destructive steps)
SELECT count(*) AS receipts_to_delete
  FROM receipts
 WHERE created_at::date = '2026-08-11' AND purpose = 'Bank Audit Entry';

-- 2) Clear the number + link on the bank entries themselves
UPDATE bank_audit_entries
   SET receipt_no = NULL, receipt_id = NULL
 WHERE receipt_id IN (
   SELECT id FROM receipts
   WHERE created_at::date = '2026-08-11' AND purpose = 'Bank Audit Entry'
 );

-- 3) Drop the receipt records (62). receipt_claims cascade (0 here);
--    nothing else references them.
DELETE FROM receipts
 WHERE created_at::date = '2026-08-11' AND purpose = 'Bank Audit Entry';

-- 4) Verify: expect 0 remaining receipts for this set
SELECT count(*) AS remaining
  FROM receipts
 WHERE created_at::date = '2026-08-11' AND purpose = 'Bank Audit Entry';

COMMIT;
