-- ============================================================================
-- FIX ASHRAY (aflf) RECEIPT NGO LABEL + RESET INFLATED COUNTER
--
-- Confirmed facts (verified against production DB via SSH tunnel):
--   * Ashray's REAL last receipt number is 19044 (next = 19045).
--   * Being Sevak (bsct) last = 82307 (next = 82308)  -- correct, DO NOT touch.
--   * Only ONE receipt was mis-tagged: Chintan Anand, receipt_no 82305, was
--     stored with project_id='aflf' so it displayed "Ashray For Life
--     Foundation" in ReceiptHistory. It is Being Sevak money (the matching
--     verified bank-audit entry id 891 is project_id='bsct', receipt_no 82305),
--     and 82305 is the CORRECT Being Sevak number. That single bad tagging is
--     what inflated the Ashray counter to ~82305; afters fixing the tag,
--     Ashray's max real receipt is 19044.
--
-- This script:
--   PART 1 (diagnostic)   — find every 'aflf' receipt whose number is outside
--                           Ashray's real range (> 19044) => these are the
--                           Being-Sevak receipts wrongly tagged as 'aflf'.
--   PART 2 (correction)   — reclassify those specific receipts back to 'bsct'
--                           and reset Ashray's counter to 19044.
--
-- Run on the EC2 / via tunnel:
--   psql "$DATABASE_URL" -f fix_ashray_receipt_numbers.sql
-- ============================================================================

-- ============================================================================
-- PART 1 — DIAGNOSTIC (READ ONLY). Run first, review, THEN run PART 2.
-- ============================================================================

-- All 'aflf' (Ashray) receipts with a number ABOVE Ashray's real last (19044).
-- These are Being-Sevak receipts wrongly tagged as Ashray -> reclassify to 'bsct'.
SELECT r.id, r.donor_name, r.receipt_no, r.receipt_date,
       r.project_id AS receipt_project,
       b.project_id AS entry_project,
       d.project_supported AS donor_project
FROM receipts r
LEFT JOIN bank_audit_entries b ON b.receipt_id = r.id
LEFT JOIN donor_profiles d ON d.id = r.donor_id
WHERE r.project_id = 'aflf'
  AND r.receipt_no ~ '^[0-9]+$'
  AND r.receipt_no::bigint > 19044
ORDER BY r.receipt_no DESC;

-- Sanity: duplicate (project_id, receipt_no) check after reclassification.
-- SELECT project_id, receipt_no, count(*) FROM receipts
-- WHERE receipt_no ~ '^[0-9]+$' GROUP BY project_id, receipt_no HAVING count(*) > 1;

-- ============================================================================
-- PART 2 — CORRECTION. Uncomment the lines below AFTER reviewing PART 1.
-- ============================================================================

-- BEGIN;

-- Step A: Reclassify every 'aflf' receipt whose number is above Ashray's real
-- last (19044) back to 'bsct'. (In the live run this was just Chintan Anand
-- 82305.) The NOT EXISTS guard avoids violating UNIQUE(project_id, receipt_no).
-- WITH to_fix AS (
--   SELECT r.id AS receipt_id, r.receipt_no
--   FROM receipts r
--   WHERE r.project_id = 'aflf'
--     AND r.receipt_no ~ '^[0-9]+$'
--     AND r.receipt_no::bigint > 19044
--     AND NOT EXISTS (
--       SELECT 1 FROM receipts bs
--       WHERE bs.project_id = 'bsct' AND bs.receipt_no = r.receipt_no
--     )
-- )
-- UPDATE receipts r
-- SET project_id = 'bsct'
-- FROM to_fix f
-- WHERE r.id = f.receipt_id;

-- Step B: Reset Ashray's receipt counter to its REAL last number (19044),
-- so the next Ashray receipt is 19045.
-- UPDATE receipt_no_counters SET last_no = 19044 WHERE project_id = 'aflf';
-- INSERT INTO receipt_no_counters (project_id, last_no)
-- SELECT 'aflf', 19044 WHERE NOT EXISTS (SELECT 1 FROM receipt_no_counters WHERE project_id = 'aflf');

-- Step C: Verify the new counter states and no duplicates were created.
-- SELECT project_id, last_no, last_no + 1 AS next_no
-- FROM receipt_no_counters
-- WHERE project_id IN ('bsct','aflf','mann')
-- ORDER BY project_id;

-- SELECT project_id, receipt_no, count(*)
-- FROM receipts
-- WHERE receipt_no ~ '^[0-9]+$'
-- GROUP BY project_id, receipt_no
-- HAVING count(*) > 1;

-- COMMIT;
