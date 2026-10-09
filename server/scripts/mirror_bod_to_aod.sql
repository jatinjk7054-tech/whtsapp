-- Mirror every active BOD donor set onto the same-numbered AOD station.
-- Example: BOD-1 -> AOD-1, BOD-17 -> AOD-17.
-- Re-runnable thanks to the NOT EXISTS guard.

BEGIN;

WITH bod AS (
  SELECT donor_id, status, batch_id, batch_type, assigned_by, assigned_at,
         upper(regexp_replace(station, '^BOD-', '', 'i')) AS n
  FROM fro_assignments
  WHERE station ILIKE 'BOD-%'
    AND status <> 'reassigned'
),
aod AS (
  SELECT station, ngo_id, fro_worker_id, upper(regexp_replace(station, '^AOD-', '', 'i')) AS n
  FROM fro_station_assignments
  WHERE station ILIKE 'AOD-%'
)
INSERT INTO fro_assignments (donor_id, ngo_id, fro_worker_id, station, status, batch_id, batch_type, assigned_by, assigned_at, updated_at)
SELECT DISTINCT
       b.donor_id, a.ngo_id, a.fro_worker_id, 'AOD-' || b.n,
       b.status, b.batch_id, b.batch_type, b.assigned_by, b.assigned_at, now()
  FROM bod b
  JOIN aod a ON a.n = b.n
 WHERE NOT EXISTS (
         SELECT 1 FROM fro_assignments x
         WHERE x.station ILIKE ('AOD-' || b.n)
           AND x.donor_id = b.donor_id
           AND x.status <> 'reassigned'
       );

COMMIT;

-- Verify counts per paired station after COMMIT:
-- SELECT split_part(station, '-', 1) AS grp, split_part(station, '-', 2) AS n, COUNT(DISTINCT donor_id) AS donors
-- FROM fro_assignments
-- WHERE (station ILIKE 'BOD-%' OR station ILIKE 'AOD-%') AND status <> 'reassigned'
-- GROUP BY 1, 2 ORDER BY 1, 2::int;
