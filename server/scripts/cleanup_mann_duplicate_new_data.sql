-- ############################################################################
-- Cleanup: duplicate MANN fresh-FD distribution from batch 'f1515313...'
-- Date: 2026-09-05
--
-- Situation:
--   Batch f1515313 (Unite, 2026-08-27) = 18,440 distinct mobiles replicated to
--   all 3 NGOs (BSCT/MANN/AFLF) in new_data, although 100% already existed in
--   old donor_profiles. MANN was force-distributed to FD stations, creating
--   duplicate (donor, MANN) fro_assignments (batch_type='new_data') and
--   flipping the pre-existing old OD rows to 'reassigned'.
--
-- Policy (Option 2 — protect money, clean everything else):
--   * PROTECT: fresh MANN assignments that carry REAL money in donor_logs
--     (accounts_status IN ('verified','pending') OR amount_collected > 0).
--     These are excluded from cleanup: assignment stays active, their flipped
--     OD row stays as-is, and their MANN new_data rows are kept.
--   * CLEAN: every OTHER duplicate fresh MANN assignment (incl. call-only,
--     zero-money rows): soft-mark status='reassigned' (app convention), restore
--     that donor's flipped OD row to 'pending', and delete its new_data rows.
--   * BSCT/AFLF: all their batch new_data rows deleted (never distributed).
--   * donor_profiles, fro_donor_logs, fro_scheduled_contacts, collections,
--     receipts and other batches are NEVER touched.
--
-- Safety:
--   * Runs in ONE transaction — any exception rolls back everything.
--   * Protect/clean sets are recomputed AT EXECUTION TIME so money that
--     appears mid-run is excluded automatically.
--   * Hard abort if protected money assignments > 500 (premise wrong).
--   * Idempotent — safe to re-run; sets are recomputed each time.
--   * Run the pg_dump backup first (command at the bottom of this file).
-- ############################################################################

-- P0: confirm the batch + its shape
SELECT import_batch_id, ngo,
       COUNT(*) AS rows,
       COUNT(DISTINCT mobile_number) AS distinct_mobiles
FROM new_data
WHERE import_batch_id::text LIKE 'f1515313%'
GROUP BY import_batch_id, ngo
ORDER BY ngo;

-- P1: ALL duplicate fresh MANN assignments (clean candidates, before money guard)
SELECT COUNT(*) AS dup_fresh_candidates
FROM fro_assignments fa
WHERE fa.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
  AND COALESCE(fa.batch_type, '') = 'new_data'
  AND COALESCE(fa.status, '') <> 'reassigned'
  AND EXISTS (
    SELECT 1 FROM fro_assignments od
    WHERE od.donor_id = fa.donor_id
      AND od.ngo_id = fa.ngo_id
      AND COALESCE(od.batch_type, '') <> 'new_data'
  );

-- P2: money-bearing fresh MANN assignments (PROTECTED — never touched)
SELECT COUNT(DISTINCT fa.id) AS money_assignments_protected,
       COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified'), 0) AS verified_amount
FROM fro_assignments fa
JOIN fro_donor_logs l ON l.assignment_id = fa.id
WHERE fa.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
  AND COALESCE(fa.batch_type, '') = 'new_data'
  AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0);

-- P3: MANN old OD rows wrongly flipped to 'reassigned' (restore candidates)
SELECT COUNT(*) AS od_rows_flipped
FROM fro_assignments od
WHERE od.status = 'reassigned'
  AND od.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
  AND COALESCE(od.batch_type, '') <> 'new_data'
  AND EXISTS (
    SELECT 1 FROM fro_assignments fd
    WHERE fd.donor_id = od.donor_id
      AND fd.ngo_id = od.ngo_id
      AND COALESCE(fd.batch_type, '') = 'new_data'
  );

-- ############################################################################
-- EXECUTION (single transaction — any exception rolls everything back)
-- ############################################################################
DO $$
DECLARE
  v_batch            uuid;
  v_protected        bigint;
  v_protected_amount numeric;
  v_to_soft          bigint;
  v_restore          bigint;
  v_newdata          bigint;
BEGIN
  SELECT import_batch_id INTO v_batch
  FROM new_data
  WHERE import_batch_id::text LIKE 'f1515313%'
  LIMIT 1;
  IF v_batch IS NULL THEN
    RAISE EXCEPTION 'batch f1515313* not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM ngos WHERE name = 'MANN') THEN
    RAISE EXCEPTION 'NGO MANN not found';
  END IF;

  -- Protected set: fresh MANN assignments carrying real money.
  -- NOTE: ngos.id / fro_assignments.ngo_id may be UUID or integer depending on
  -- the DB; we NEVER store that id in a typed variable — always resolve MANN by
  -- name via a join or inline sub-query so this runs on either schema.
  CREATE TEMP TABLE tmp_protected AS
  SELECT DISTINCT fa.donor_id AS donor_id
  FROM fro_assignments fa
  JOIN ngos ng ON ng.id = fa.ngo_id AND ng.name = 'MANN'
  JOIN fro_donor_logs l ON l.assignment_id = fa.id
  WHERE COALESCE(fa.batch_type, '') = 'new_data'
    AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0);

  SELECT COUNT(*) INTO v_protected FROM tmp_protected;

  IF v_protected > 500 THEN
    RAISE EXCEPTION 'ABORT: % money-bearing fresh assignments — far more than expected. Reassess.', v_protected;
  END IF;

  SELECT COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified'), 0)
  INTO v_protected_amount
  FROM fro_assignments fa
  JOIN ngos ng ON ng.id = fa.ngo_id AND ng.name = 'MANN'
  JOIN fro_donor_logs l ON l.assignment_id = fa.id
  WHERE COALESCE(fa.batch_type, '') = 'new_data'
    AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0);

  -- Clean set: duplicate fresh MANN assignments EXCLUDING protected ones
  CREATE TEMP TABLE tmp_mann_fresh_to_soft AS
  SELECT fa.id AS assignment_id
  FROM fro_assignments fa
  WHERE fa.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
    AND COALESCE(fa.batch_type, '') = 'new_data'
    AND COALESCE(fa.status, '') <> 'reassigned'
    AND EXISTS (
      SELECT 1 FROM fro_assignments od
      WHERE od.donor_id = fa.donor_id
        AND od.ngo_id = fa.ngo_id
        AND COALESCE(od.batch_type, '') <> 'new_data'
    )
    AND fa.donor_id NOT IN (SELECT donor_id FROM tmp_protected);

  -- OD restore set: flipped OD rows whose donor has a fresh counterpart being cleaned
  CREATE TEMP TABLE tmp_mann_od_to_restore AS
  SELECT od.id AS assignment_id
  FROM fro_assignments od
  WHERE od.status = 'reassigned'
    AND od.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
    AND COALESCE(od.batch_type, '') <> 'new_data'
    AND EXISTS (
      SELECT 1 FROM tmp_mann_fresh_to_soft ts
      JOIN fro_assignments fd ON fd.id = ts.assignment_id
      WHERE fd.donor_id = od.donor_id
    );

  SELECT COUNT(*) INTO v_to_soft FROM tmp_mann_fresh_to_soft;
  SELECT COUNT(*) INTO v_restore FROM tmp_mann_od_to_restore;

  RAISE NOTICE 'protected money-bearing assignments: % (verified amount %)', v_protected, v_protected_amount;
  RAISE NOTICE 'fresh dups to soft-mark (excl. protected): %', v_to_soft;
  RAISE NOTICE 'OD rows to restore to pending: %', v_restore;

  -- 1) Restore the OD rows the bug flipped away
  UPDATE fro_assignments od
  SET status = 'pending'
  FROM tmp_mann_od_to_restore t
  WHERE od.id = t.assignment_id;

  -- 2) Soft-mark the duplicate fresh assignments (app convention for inactive)
  UPDATE fro_assignments fa
  SET status = 'reassigned'
  FROM tmp_mann_fresh_to_soft t
  WHERE fa.id = t.assignment_id;

  -- 3) Delete the batch's new_data rows, EXCEPT the protected donors' MANN rows
  DELETE FROM new_data
  WHERE import_batch_id = v_batch
    AND NOT (
      ngo = 'MANN'
      AND mobile_number IN (
        SELECT dp.mobile_number
        FROM donor_profiles dp
        JOIN tmp_protected p ON p.donor_id = dp.id
      )
    );
  GET DIAGNOSTICS v_newdata = ROW_COUNT;
  RAISE NOTICE 'deleted % new_data rows (batch kept only for protected MANN donors)', v_newdata;

  DROP TABLE tmp_protected;
  DROP TABLE tmp_mann_fresh_to_soft;
  DROP TABLE tmp_mann_od_to_restore;

  RAISE NOTICE 'DONE — protected=%, restored=%, soft-marked=%, new_data deleted=%',
    v_protected, v_restore, v_to_soft, v_newdata;
END $$;

-- ############################################################################
-- Verification after cleanup (read-only)
-- ############################################################################

-- 1) Duplicate active (donor, NGO) pairs should be empty for all NGOs:
SELECT fa.donor_id, dp.mobile_number, n.name AS ngo_name, fa.station, fa.status
FROM fro_assignments fa
JOIN ngos n ON n.id = fa.ngo_id
LEFT JOIN donor_profiles dp ON dp.id = fa.donor_id
WHERE COALESCE(fa.status, '') <> 'reassigned'
  AND (fa.donor_id, fa.ngo_id) IN (
    SELECT donor_id, ngo_id FROM fro_assignments
    WHERE COALESCE(status, '') <> 'reassigned'
    GROUP BY donor_id, ngo_id HAVING COUNT(*) > 1
  )
ORDER BY fa.donor_id;

-- 2) Batch rows remaining (expected: only the protected MANN donor's rows):
SELECT ngo, COUNT(*) AS remaining_rows
FROM new_data
WHERE import_batch_id::text LIKE 'f1515313%'
GROUP BY ngo ORDER BY ngo;

-- 3) The protected money row is still live:
SELECT fa.donor_id, dp.mobile_number, fa.station, l.accounts_status, l.amount_collected
FROM fro_assignments fa
JOIN fro_donor_logs l ON l.assignment_id = fa.id
JOIN ngos n ON n.id = fa.ngo_id
LEFT JOIN donor_profiles dp ON dp.id = fa.donor_id
WHERE n.name = 'MANN'
  AND COALESCE(fa.batch_type, '') = 'new_data'
  AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0)
ORDER BY l.verified_at DESC NULLS LAST;

-- ############################################################################
-- BACKUP (run before executing this script, on the DB host):
--   pg_dump -h <RDS-endpoint> -U <user> -d <dbname> \
--     -t new_data -t fro_assignments -t fro_donor_logs -t fro_scheduled_contacts \
--     -Fc -f pre_cleanup_batch_$(date +%Y%m%d).dump
-- Restore if needed from a clean shell (not while the app is writing).
-- ############################################################################