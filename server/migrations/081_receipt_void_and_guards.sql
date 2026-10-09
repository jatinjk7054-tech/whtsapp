-- 081: receipt voiding + receipt-number safety guards
-- Purpose: make it impossible to silently miss / delete / hide a receipt number.
--   - voided_at / void_reason let a receipt be cancelled WITHOUT losing its number.
--   - Guard 1 blocks erasing (nulling) an already-assigned receipt number.
--   - Guard 2 blocks hard-deleting a numbered receipt that is NOT the latest for
--     its project (deleting the latest is safe — the counter simply steps back).

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS void_reason text;

-- Guard 1: never let a receipt number be wiped to NULL once assigned.
CREATE OR REPLACE FUNCTION public.receipts_guard_number_erase() RETURNS trigger AS $$
BEGIN
  IF OLD.receipt_no IS NOT NULL AND OLD.receipt_no <> ''
     AND (NEW.receipt_no IS NULL OR NEW.receipt_no = '') THEN
    RAISE EXCEPTION 'Cannot clear receipt_no % — void the receipt instead.', OLD.receipt_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_receipts_guard_number_erase ON receipts;
CREATE TRIGGER trg_receipts_guard_number_erase
  BEFORE UPDATE OF receipt_no ON receipts
  FOR EACH ROW EXECUTE FUNCTION public.receipts_guard_number_erase();

-- Guard 2: never hard-delete a numbered receipt unless it is the highest number
-- for its project (so the counter can step back with no gap).
CREATE OR REPLACE FUNCTION public.receipts_guard_numbered_delete() RETURNS trigger AS $$
DECLARE
  v_max bigint;
BEGIN
  IF OLD.receipt_no IS NOT NULL AND OLD.receipt_no <> '' AND OLD.receipt_no ~ '^[0-9]+$' THEN
    SELECT COALESCE(MAX(CASE WHEN receipt_no ~ '^[0-9]+$' THEN receipt_no::bigint END), 0)
      INTO v_max
      FROM receipts
      WHERE project_id = OLD.project_id AND id <> OLD.id;
    IF OLD.receipt_no::bigint < v_max THEN
      RAISE EXCEPTION 'Cannot delete numbered receipt % (project %) — void it instead.', OLD.receipt_no, OLD.project_id;
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_receipts_guard_numbered_delete ON receipts;
CREATE TRIGGER trg_receipts_guard_numbered_delete
  BEFORE DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION public.receipts_guard_numbered_delete();
