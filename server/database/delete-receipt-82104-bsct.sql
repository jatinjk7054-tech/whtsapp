-- Delete receipt 82104 for bsct from production
-- Unlinks any bank_audit_entries first, then deletes the receipt.

-- 1. Find the receipt ID
DO $$
DECLARE
  rec_id bigint;
BEGIN
  SELECT id INTO rec_id FROM receipts WHERE receipt_no = '82104' AND project_id = 'bsct';

  IF rec_id IS NULL THEN
    RAISE NOTICE 'Receipt 82104 (bsct) not found';
    RETURN;
  END IF;

  RAISE NOTICE 'Found receipt id=%, unlinking bank_audit_entries...', rec_id;

  -- 2. Unlink bank_audit_entries
  UPDATE bank_audit_entries SET receipt_id = NULL WHERE receipt_id = rec_id;

  -- 3. Delete the receipt
  DELETE FROM receipts WHERE id = rec_id;

  RAISE NOTICE 'Deleted receipt 82104 (bsct), id=%', rec_id;
END $$;
