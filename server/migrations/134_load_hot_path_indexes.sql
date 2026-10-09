-- 134: Hot-path indexes to cut RDS (t3.micro) CPU.
-- IMPORTANT: run during low-traffic time (evening/night), same as 095.
-- Each CREATE INDEX briefly blocks writes on that table (a few seconds).
-- Reads are never blocked. All statements are IF NOT EXISTS (safe to re-run).
--
-- Covered queries:
--   getLiveStatuses ......... per-worker today's donor logs + assignments
--   refreshSpecialIncentive . WINDOW_COLLECTION_SQL join (logs -> assignments)
--   special_incentive_progress batched read per incentive
--   attendance punch-in lookup per worker set

CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_worker_created
  ON fro_donor_logs (fro_worker_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_worker_verified
  ON fro_donor_logs (fro_worker_id, verified_at);
CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_assignment
  ON fro_donor_logs (assignment_id);
CREATE INDEX IF NOT EXISTS idx_fro_assignments_worker
  ON fro_assignments (fro_worker_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date_worker
  ON attendance (date, worker_id);
CREATE INDEX IF NOT EXISTS idx_special_progress_incentive_worker
  ON special_incentive_progress (special_incentive_id, worker_id);
CREATE INDEX IF NOT EXISTS idx_allocations_worker
  ON worker_ngo_allocations (worker_id);
