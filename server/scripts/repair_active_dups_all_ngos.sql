-- repair_active_dups_all_ngos.sql
-- Restore the invariant: ONE active fro_assignment per (donor_id, ngo_id),
-- across ALL NGOs (generalizes repair_mann_active_dups.sql).
--   Active  = status IS NULL OR status <> 'reassigned'
--   Money   = fro_donor_logs.accounts_status IN ('verified','pending')
--             OR fro_donor_logs.amount_collected > 0   (linked via assignment_id)
--   Rule    = keep every money-bearing assignment group; for a (donor_id, ngo_id)
--             group with no money, keep the "most worked" row (a row that has
--             logs / a last_contacted_at, latest first) falling
--             back to the earliest-assigned row.
--   Action  = soft-mark the rest as 'reassigned' (no deletes, no touch of
--             logs/receipts). Keeps the disposed/terminal row (which rightfully
--             hides the donor) instead of resurrecting a stale pending twin.
-- Safe to run repeatedly (idempotent, single transaction).
-- After this, run add_assignment_dedup_index.sql to lock the partial unique index.

BEGIN;

DO $$
DECLARE
  v_dups      bigint;
  v_protected bigint;
BEGIN
  SELECT COUNT(*) INTO v_dups
  FROM (
    SELECT donor_id, ngo_id
    FROM fro_assignments
    WHERE status IS NULL OR status <> 'reassigned'
    GROUP BY donor_id, ngo_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dups = 0 THEN
    RAISE NOTICE 'NO active duplicate (donor_id, ngo_id) assignments - nothing to do';
    RETURN;
  END IF;
  RAISE NOTICE 'active duplicate (donor_id, ngo_id) pairs: %', v_dups;

  SELECT COUNT(*) INTO v_protected
  FROM (
    SELECT DISTINCT fa.id
    FROM fro_assignments fa
    JOIN fro_donor_logs l ON l.assignment_id = fa.id
    WHERE (fa.status IS NULL OR fa.status <> 'reassigned')
      AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0)
  ) p;

  IF v_protected > 2000 THEN
    RAISE EXCEPTION 'ABORT: % protected money-bearing assignments exceed safety cap 2000', v_protected;
  END IF;
  RAISE NOTICE 'protected money-bearing assignments: %', v_protected;
END $$;

-- Snapshot active rows.
DROP TABLE IF EXISTS tmp_active_all;
CREATE TEMP TABLE tmp_active_all AS
SELECT a.id, a.donor_id, a.ngo_id, a.assigned_at, a.last_contacted_at, a.status
FROM fro_assignments a
WHERE (a.status IS NULL OR a.status <> 'reassigned');

-- (donor_id, ngo_id) groups that carry money: every one of their rows is kept.
DROP TABLE IF EXISTS tmp_money_all;
CREATE TEMP TABLE tmp_money_all AS
SELECT DISTINCT fa.donor_id, fa.ngo_id
FROM fro_assignments fa
JOIN fro_donor_logs l ON l.assignment_id = fa.id
WHERE (fa.status IS NULL OR fa.status <> 'reassigned')
  AND (l.accounts_status IN ('verified', 'pending') OR l.amount_collected > 0);

-- Any disposition/activity count per assignment (worked = has logs).
DROP TABLE IF EXISTS tmp_worked_all;
CREATE TEMP TABLE tmp_worked_all AS
SELECT l.assignment_id AS id, COUNT(*) AS log_count, MAX(l.created_at) AS last_log_at
FROM fro_donor_logs l
GROUP BY l.assignment_id;

-- Kept: money groups (ALL rows) + ROW_NUMBER best row per non-money group.
DROP TABLE IF EXISTS tmp_kept_all;
CREATE TEMP TABLE tmp_kept_all AS
SELECT a.id
FROM tmp_active_all a
JOIN tmp_money_all m ON m.donor_id = a.donor_id AND m.ngo_id = a.ngo_id
UNION
SELECT id
FROM (
  SELECT a.id, a.donor_id, a.ngo_id,
         ROW_NUMBER() OVER (
           PARTITION BY a.donor_id, a.ngo_id
           ORDER BY
             (CASE WHEN w.id IS NULL THEN 1 ELSE 0 END),   -- worked rows first
COALESCE(a.last_contacted_at, w.last_log_at) DESC NULLS LAST,
              a.assigned_at ASC NULLS LAST,
             a.id ASC
         ) AS rn
  FROM tmp_active_all a
  LEFT JOIN tmp_worked_all w ON w.id = a.id
  LEFT JOIN tmp_money_all m ON m.donor_id = a.donor_id AND m.ngo_id = a.ngo_id
  WHERE m.donor_id IS NULL
) r
WHERE r.rn = 1;

-- Soft-mark the rest.
DROP TABLE IF EXISTS tmp_tosoft_all;
CREATE TEMP TABLE tmp_tosoft_all AS
SELECT id
FROM tmp_active_all
EXCEPT
SELECT id FROM tmp_kept_all;

SELECT
  (SELECT COUNT(*) FROM tmp_active_all)  AS active_total,
  (SELECT COUNT(*) FROM tmp_kept_all)    AS kept_rows,
  (SELECT COUNT(*) FROM tmp_tosoft_all)  AS to_soft_mark;

UPDATE fro_assignments a
SET status = 'reassigned'
WHERE a.id IN (SELECT id FROM tmp_tosoft_all);

SELECT COUNT(*) AS soft_marked FROM tmp_tosoft_all;

-- ── Verification ───────────────────────────────────────────────────────────
SELECT 'active_dup_pairs_remaining' AS check_name, COUNT(*) AS value
FROM (
  SELECT donor_id, ngo_id
  FROM fro_assignments
  WHERE status IS NULL OR status <> 'reassigned'
  GROUP BY donor_id, ngo_id
  HAVING COUNT(*) > 1
) d;

COMMIT;