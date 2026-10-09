-- 097: Station bulk-rename audit log.
--
-- Records every (ngo, old_station -> new_station) rename performed via the
-- ngo-admin bulk rename tool, including per-table affected row counts, so the
-- mapping is preserved after the old codes are erased from the live tables.
-- The bulkRenameStations handler also runs this DDL (IF NOT EXISTS) on first
-- use, so environments that cannot run migrations manually (e.g. the Vercel
-- deployment against RDS) still get the table automatically.

CREATE TABLE IF NOT EXISTS station_rename_log (
  id             bigserial PRIMARY KEY,
  ngo_id         uuid,
  ngo_name       text,
  old_station    text NOT NULL,
  new_station    text NOT NULL,
  counts         jsonb NOT NULL DEFAULT '{}',
  skipped_donors integer NOT NULL DEFAULT 0,
  performed_by   text,
  performed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_station_rename_log_ngo_time
  ON station_rename_log(ngo_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_station_rename_log_old_station
  ON station_rename_log(old_station);
