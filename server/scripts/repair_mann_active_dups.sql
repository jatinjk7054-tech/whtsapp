-- repair_mann_active_dups.sql
-- Restore the invariant: ONE active fro_assignment per MANN donor.
--   Active = status IS NULL OR status <> 'reassigned'
--   Money  = fro_donor_logs.accounts_status IN ('verified','pending')
--            OR fro_donor_logs.amount_collected > 0   (linked via assignment_id)
--   Rule   = keep every money-bearing assignment; for a donor with no money
--            assignment, keep the earliest-assigned active row.
--   Action = soft-mark the rest as 'reassigned' (no deletes, no touch of logs/receipts).
-- Safe to run repeatedly (idempotent, single transaction, MANN only).

BEGIN;

DO $$
DECLARE
  v_mann      uuid;
  v_dups      bigint;
  v_protected bigint;
BEGIN
  SELECT id INTO v_mann FROM ngos WHERE name = 'MANN';
  IF v_mann IS NULL THEN
    RAISE EXCEPTION 'MANN ngo not found - abort';
  END IF;

  SELECT COUNT(*) INTO v_dups
  FROM (
    SELECT donor_id
    FROM fro_assignments
    WHERE ngo_id = v_mann
      AND (status IS NULL OR status <> 'reassigned')
    GROUP BY donor_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dups = 0 THEN
    RAISE NOTICE 'NO active duplicate MANN assignments - nothing to do';
    RETURN;
  END IF;
  RAISE NOTICE 'MANN donors with >1 active assignment: %', v_dups;

  SELECT COUNT(*) INTO v_protected
  FROM (
    SELECT DISTINCT fa.id
    FROM fro_assignments fa
    JOIN fro_donor_logs l ON l.assignment_id = fa.id
    WHERE fa.ngo_id = v_mann
      AND (fa.status IS NULL OR fa.status <> 'reassigned')
      AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0)
  ) p;

  IF v_protected > 500 THEN
    RAISE EXCEPTION 'ABORT: % protected money-bearing assignments exceed safety cap 500', v_protected;
  END IF;
  RAISE NOTICE 'protected money-bearing MANN assignments: %', v_protected;
END $$;

-- Snapshot active MANN rows.
DROP TABLE IF EXISTS tmp_mann_active;
CREATE TEMP TABLE tmp_mann_active AS
SELECT a.id, a.donor_id, a.assigned_at
FROM fro_assignments a
WHERE a.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
  AND (a.status IS NULL OR a.status <> 'reassigned');

-- Donors that carry money: every one of their active rows is kept.
DROP TABLE IF EXISTS tmp_mann_money_donors;
CREATE TEMP TABLE tmp_mann_money_donors AS
SELECT DISTINCT fa.donor_id
FROM fro_assignments fa
JOIN fro_donor_logs l ON l.assignment_id = fa.id
WHERE fa.ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
  AND (fa.status IS NULL OR fa.status <> 'reassigned')
  AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0);

-- Kept: money rows + ROW_NUMBER earliest per donor without money.
DROP TABLE IF EXISTS tmp_mann_kept;
CREATE TEMP TABLE tmp_mann_kept AS
SELECT a.id
FROM tmp_mann_active a
JOIN tmp_mann_money_donors md ON md.donor_id = a.donor_id
UNION
SELECT id
FROM (
  SELECT a.id, a.donor_id,
         ROW_NUMBER() OVER (
           PARTITION BY a.donor_id
           ORDER BY a.assigned_at ASC NULLS LAST, a.id ASC
         ) AS rn
  FROM tmp_mann_active a
  LEFT JOIN tmp_mann_money_donors md ON md.donor_id = a.donor_id
  WHERE md.donor_id IS NULL
) r
WHERE r.rn = 1;

-- Soft-mark the rest.
DROP TABLE IF EXISTS tmp_mann_tosoft;
CREATE TEMP TABLE tmp_mann_tosoft AS
SELECT id
FROM tmp_mann_active
EXCEPT
SELECT id FROM tmp_mann_kept;

SELECT
  (SELECT COUNT(*) FROM tmp_mann_active)          AS active_total,
  (SELECT COUNT(*) FROM tmp_mann_kept)            AS kept_rows,
  (SELECT COUNT(*) FROM tmp_mann_tosoft)          AS to_soft_mark;

UPDATE fro_assignments a
SET status = 'reassigned'
WHERE a.id IN (SELECT id FROM tmp_mann_tosoft);

SELECT COUNT(*) AS soft_marked FROM tmp_mann_tosoft;

-- ── Verification ───────────────────────────────────────────────────────────
SELECT 'active_dup_pairs' AS check_name,
       COUNT(*) AS value
FROM (
  SELECT donor_id
  FROM fro_assignments
  WHERE ngo_id = (SELECT id FROM ngos WHERE name = 'MANN')
    AND (status IS NULL OR status <> 'reassigned')
  GROUP BY donor_id
  HAVING COUNT(*) > 1
) d;

SELECT 'donor_463051_7506006778' AS check_name,
       fa.donor_id, dp.mobile_number AS mobile, fa.station, fa.status,
       l.accounts_status, l.amount_collected, l.verified_at
FROM fro_assignments fa
JOIN donor_profiles dp ON dp.id = fa.donor_id
LEFT JOIN fro_donor_logs l ON l.assignment_id = fa.id
WHERE dp.id = 463051
   OR dp.mobile_number = '7506006778'
ORDER BY l.verified_at DESC NULLS LAST;

COMMIT;