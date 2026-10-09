-- Hard reset BOD-17 data: first strip every trace of a previous BOD-17,
-- then re-run the AOD-17 -> BOD-17 copy. AOD-17 is left untouched.

BEGIN;

-- 1) Clear old BOD-17 donor rows from donor_profiles (the source of the
--    donor-count on the stations page).
UPDATE donor_profiles SET station = NULL WHERE station ILIKE 'BOD-17';

-- 2) Clear old BOD-17 assignment / DND / queue rows so the count is not
--    inflated by stale rows left behind when the station was deleted.
DELETE FROM fro_assignments WHERE station ILIKE 'BOD-17';
DELETE FROM donor_dnd       WHERE station ILIKE 'BOD-17';
DELETE FROM work_queue       WHERE station ILIKE 'BOD-17';

-- 3) Also clear BOD-17 station mappings so the next INSERT starts fresh.
DELETE FROM fro_station_assignments WHERE station ILIKE 'BOD-17';

COMMIT;

-- ---- Copy AOD-17 to BOD-17 ------------------------------------------------
BEGIN;

CREATE TEMP TABLE _bod_ngo AS
SELECT DISTINCT ngo_id
FROM fro_station_assignments
WHERE station ILIKE ANY (ARRAY['BOD-%', 'BFD-%'])
LIMIT 1;

INSERT INTO fro_station_assignments (fro_worker_id, ngo_id, station, assigned_by, created_at, updated_at)
SELECT a.fro_worker_id, t.ngo_id, 'BOD-17', a.assigned_by, now(), now()
FROM fro_station_assignments a
CROSS JOIN _bod_ngo t
WHERE a.station ILIKE 'AOD-17'
  AND NOT EXISTS (
    SELECT 1 FROM fro_station_assignments x
    WHERE x.station ILIKE 'BOD-17'
      AND x.fro_worker_id = a.fro_worker_id
      AND x.ngo_id = t.ngo_id
  );

-- donors: only donor_profiles whose current station is AOD-17 and whose ngo
-- is the one at which the target station lives (BSCT) get their station
-- changed to BOD-17. Donors that belong to a different NGO for BOD-17 are
-- left on AOD-17 — a donor row keeps exactly one station.
UPDATE donor_profiles dp
   SET station = 'BOD-17'
  FROM fro_station_assignments s
  JOIN _bod_ngo b ON b.ngo_id = s.ngo_id
 WHERE s.station ILIKE 'BOD-17'
   AND dp.station ILIKE 'AOD-17'
   AND dp.ngo    = b.ngo_id::text;

COMMIT;
