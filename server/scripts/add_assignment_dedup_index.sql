-- DB-level backstop for the "one active fro_assignment per (donor, NGO)" rule.
-- Run this ONLY after duplicate repair (repair_mann_active_dups.sql): it aborts
-- while any active duplicate (donor_id, ngo_id) pairs remain.
--
-- "Active" matches the guards' semantics: status IS NULL OR status <> 'reassigned'.

DO $$
DECLARE
  v_dups BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_fro_assignments_active_donor_ngo'
  ) THEN
    RAISE NOTICE 'SKIP: index uq_fro_assignments_active_donor_ngo already exists';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_dups
  FROM (
    SELECT donor_id, ngo_id
    FROM fro_assignments
    WHERE status IS NULL OR status <> 'reassigned'
    GROUP BY donor_id, ngo_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dups > 0 THEN
    RAISE EXCEPTION 'ABORT: % active duplicate (donor_id, ngo_id) pairs remain - run repair_mann_active_dups.sql first', v_dups;
  END IF;

  CREATE UNIQUE INDEX uq_fro_assignments_active_donor_ngo
    ON fro_assignments (donor_id, ngo_id)
    WHERE status IS NULL OR status <> 'reassigned';

  RAISE NOTICE 'CREATED unique index uq_fro_assignments_active_donor_ngo (partial, covers NULL status)';
END $$;