-- Restore BOD-17 as a new station under the same NGO as the other BOD-* /
-- BFD-* stations (typically BSCT), and copy AOD-17's operational rows onto it.
-- AOD-17 rows stay untouched. Run in the Query Runner.

BEGIN;


-- Discover the target NGO from any existing BOD-/BFD- row. BOD-17 lands under
-- that NGO, never under AOD-17's (AFLF) NGO.
CREATE TEMP TABLE _bod_ngo AS
SELECT DISTINCT ngo_id
FROM fro_station_assignments
WHERE station ILIKE ANY (ARRAY['BOD-%', 'BFD-%'])
LIMIT 1;

-- Create one BOD-17 assignment per worker that lives on AOD-17, but re-mapped
-- to the BSCT NGO. Idempotent: no-op if the pair already exists.
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

-- Operational rows: copy AOD-17 -> BOD-17 (same donors, new station).
-- fro_assignments: new rows, new ids.
INSERT INTO fro_assignments (donor_id, ngo_id, fro_worker_id, station, status, batch_id, batch_type, assigned_by, assigned_at, updated_at)
SELECT fa.donor_id, t.ngo_id, fa.fro_worker_id, 'BOD-17',
       fa.status, fa.batch_id, fa.batch_type, fa.assigned_by, fa.assigned_at, now()
FROM fro_assignments fa
CROSS JOIN _bod_ngo t
WHERE fa.station ILIKE 'AOD-17'
  AND NOT EXISTS (
    SELECT 1 FROM fro_assignments x
    WHERE x.donor_id = fa.donor_id AND x.station ILIKE 'BOD-17' AND x.ngo_id = t.ngo_id
  );

-- donor_dnd: copy marks onto the new station.
INSERT INTO donor_dnd (donor_id, ngo_id, station, reason, marked_by, marked_at, source)
SELECT d.donor_id, t.ngo_id, 'BOD-17', d.reason, d.marked_by, now(), d.source
FROM donor_dnd d
CROSS JOIN _bod_ngo t
WHERE d.station ILIKE 'AOD-17'
  AND NOT EXISTS (
    SELECT 1 FROM donor_dnd x
    WHERE x.donor_id = d.donor_id AND x.station ILIKE 'BOD-17' AND x.ngo_id = t.ngo_id
  );

-- work_queue: safe to copy reference rows.
INSERT INTO work_queue (worker_id, operator_id, donor_id, ngo_id, station, data_tab, cycle_key, position, status, created_at, updated_at)
SELECT q.worker_id, q.operator_id, q.donor_id, t.ngo_id, 'BOD-17', q.data_tab,
       t.ngo_id::text || ':' || 'BOD-17' || ':' || split_part(q.cycle_key, ':', 3) || ':' || split_part(q.cycle_key, ':', 4),
       q.position, q.status, now(), now()
FROM work_queue q
CROSS JOIN _bod_ngo t
WHERE q.station ILIKE 'AOD-17'
  AND NOT EXISTS (
    SELECT 1 FROM work_queue x
    WHERE x.donor_id = q.donor_id AND x.station ILIKE 'BOD-17' AND x.ngo_id = t.ngo_id AND x.data_tab = q.data_tab
  );

COMMIT;
