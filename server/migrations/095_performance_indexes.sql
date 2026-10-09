-- 095: Performance indexes for NGO admin dashboard
-- IMPORTANT: run during low-traffic time (evening/night).
-- Each CREATE INDEX briefly blocks writes on that table (a few seconds),
-- so telecallers may notice a short pause. Reads are never blocked.

CREATE INDEX IF NOT EXISTS idx_receipts_receipt_date ON receipts (receipt_date);
CREATE INDEX IF NOT EXISTS idx_receipts_agent_name ON receipts (lower(agent_name));
CREATE INDEX IF NOT EXISTS idx_fro_assignments_ngo_id ON fro_assignments (ngo_id);
CREATE INDEX IF NOT EXISTS idx_fro_assignments_ngo_donor_status ON fro_assignments (ngo_id, donor_id, status);
CREATE INDEX IF NOT EXISTS idx_new_data_ngo ON new_data (ngo);
CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_created_at ON fro_donor_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_fro_station_assignments_ngo_id ON fro_station_assignments (ngo_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (date);
