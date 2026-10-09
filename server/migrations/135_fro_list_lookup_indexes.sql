-- 135: Lookup indexes for the FRO list pipeline (getMyDonors / queue_current).
-- IMPORTANT: run during low-traffic time (evening/night), same as 095/134.
-- Each CREATE INDEX briefly blocks writes on that table (a few seconds).
-- Reads are never blocked. All statements are IF NOT EXISTS (safe to re-run).
--
-- Covered queries (single DISTINCT ON / DISTINCT lookups per request):
--   latest disposition per donor .... (donor_id, action, created_at)
--   latest accounts_status per donor . (donor_id, accounts_status, created_at)
--   period activity ................. (donor_id prefix of #1)
--   today's dispositions per worker . (fro_worker_id, created_at)
--   open schedules per assignment ... partial index on incomplete rows

CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_donor_action_created
  ON fro_donor_logs (donor_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_donor_status_created
  ON fro_donor_logs (donor_id, accounts_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_worker_created
  ON fro_donor_logs (fro_worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_contacts_assignment_open
  ON fro_scheduled_contacts (assignment_id) WHERE is_completed = false;
