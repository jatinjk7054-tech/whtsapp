-- 107: Remove existing DND fro_assignments (one-time cleanup).
--
-- Business rule: a donor disposed as DND ("Do Not Disturb") should be removed
-- from the FRO's list entirely by deleting their station + agent assignment
-- (fro_assignments row), so they never reappear for that FRO.
--
-- This migration performs the one-time cleanup of ALREADY-DND assignments
-- (status = 'dnd', or with a DND disposition log on the assignment). Going
-- forward, new DND dispositions are removed by the backend discard path in
-- createDonorLogHandler.
--
-- Deleted along with each assignment:
--   * rejected_lead_tickets referencing that assignment's logs
--   * fro_donor_logs          (assignment_id)
--   * fro_scheduled_contacts  (assignment_id)
--   * the fro_assignments row itself
--   * matching work_queue rows (worker_id + donor_id) — no public FK cascade
--
-- Donor profiles, receipts, and donations are untouched.
--
-- Applied by the user via Query Runner (DB is not reachable from the app host).

BEGIN;

-- Drop any prior version of the helper function (idempotent).
DROP FUNCTION IF EXISTS cleanup_dnd_fro_assignments();

CREATE OR REPLACE FUNCTION cleanup_dnd_fro_assignments()
RETURNS TABLE(
  assignments_removed bigint,
  logs_removed       bigint,
  schedules_removed  bigint,
  tickets_removed    bigint,
  queue_removed      bigint
) AS $$
DECLARE
  a_assignments bigint;
  a_logs        bigint;
  a_schedules   bigint;
  a_tickets     bigint;
  a_queue       bigint;
BEGIN
  -- Snapshot the assignments to remove: status 'dnd', OR any assignment that
  -- carries a DND disposition log.
  CREATE TEMP TABLE tmp_dnd_assignments ON COMMIT DROP AS
    SELECT a.id,
           a.donor_id,
           a.fro_worker_id
      FROM fro_assignments a
     WHERE a.status = 'dnd'
        OR EXISTS (
             SELECT 1
               FROM fro_donor_logs l
              WHERE l.assignment_id = a.id
                AND l.action = 'disposition'
                AND l.disposition_detail = 'dnd'
           );

  -- rejected_lead_tickets referencing the removed assignments' logs.
  WITH t AS (
    DELETE FROM rejected_lead_tickets r
     USING fro_donor_logs l, tmp_dnd_assignments a
      WHERE r.fro_donor_log_id = l.id
        AND l.assignment_id = a.id
    RETURNING 1
  )
  SELECT count(*) INTO a_tickets FROM t;

  -- fro_donor_logs belonging to the removed assignments.
  WITH t AS (
    DELETE FROM fro_donor_logs l
     USING tmp_dnd_assignments a
      WHERE l.assignment_id = a.id
    RETURNING 1
  )
  SELECT count(*) INTO a_logs FROM t;

  -- fro_scheduled_contacts belonging to the removed assignments.
  WITH t AS (
    DELETE FROM fro_scheduled_contacts s
     USING tmp_dnd_assignments a
      WHERE s.assignment_id = a.id
    RETURNING 1
  )
  SELECT count(*) INTO a_schedules FROM t;

  -- work_queue rows for the affected (worker, donor) pairs.
  WITH t AS (
    DELETE FROM work_queue w
     USING tmp_dnd_assignments a
      WHERE w.worker_id = a.fro_worker_id
        AND w.donor_id  = a.donor_id
    RETURNING 1
  )
  SELECT count(*) INTO a_queue FROM t;

  -- The assignments themselves.
  WITH t AS (
    DELETE FROM fro_assignments a
     USING tmp_dnd_assignments tmd
      WHERE a.id = tmd.id
    RETURNING 1
  )
  SELECT count(*) INTO a_assignments FROM t;

  RETURN QUERY SELECT
    a_assignments,
    a_logs,
    a_schedules,
    a_tickets,
    a_queue;
END;
$$ LANGUAGE plpgsql;

-- Run the cleanup and report counts.
SELECT * FROM cleanup_dnd_fro_assignments();

-- Drop the helper (keep only the results, no lingering function).
DROP FUNCTION IF EXISTS cleanup_dnd_fro_assignments();

COMMIT;
