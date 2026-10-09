-- Attendance backfill: 2 workers, 2026-09-01 .. 2026-09-19 (Sundays skipped).
--   In-time  : random 10:00-10:30 IST
--   Out-time : random 20:00-21:30 IST
-- Times are stored as timestamptz (same as app punch-in/out).
-- status/late_minutes follow app rules (office start 10:00):
--   in at 10:00 sharp -> 'present', anything after -> 'late'.
-- Out times always clear a full shift, so no 'half-day' rows are produced.
--
-- Re-runnable: existing rows for these workers/dates are deleted first.

DELETE FROM attendance
WHERE worker_id IN (
  '0b6af56d-512c-4ffc-a671-a27ad7c7bfe0'::uuid,
  '766fc6ea-9102-45d9-9475-812287d1bbd7'::uuid
)
AND date BETWEEN '2026-09-01' AND '2026-09-19';

INSERT INTO attendance (worker_id, date, punch_in_time, punch_out_time, status, late_minutes)
SELECT
  t.worker_id,
  t.day AS date,
  ((t.day + t.in_t) AT TIME ZONE 'Asia/Kolkata') AS punch_in_time,
  ((t.day + t.out_t) AT TIME ZONE 'Asia/Kolkata') AS punch_out_time,
  CASE WHEN t.in_t > TIME '10:00' THEN 'late' ELSE 'present' END AS status,
  GREATEST(0, (EXTRACT(EPOCH FROM (t.in_t - TIME '10:00')) / 60)::int) AS late_minutes
FROM (
  SELECT
    w.worker_id,
    d.day,
    TIME '10:00'
      + (floor(random() * 31)::int || ' minutes')::interval
      + (floor(random() * 60)::int || ' seconds')::interval AS in_t,
    TIME '20:00'
      + (floor(random() * 91)::int || ' minutes')::interval
      + (floor(random() * 60)::int || ' seconds')::interval AS out_t
  FROM (VALUES
    ('0b6af56d-512c-4ffc-a671-a27ad7c7bfe0'::uuid),
    ('766fc6ea-9102-45d9-9475-812287d1bbd7'::uuid)
  ) AS w(worker_id)
  CROSS JOIN generate_series('2026-09-01'::date, '2026-09-19'::date, '1 day') AS d(day)
  WHERE EXTRACT(ISODOW FROM d.day) <> 7  -- skip Sundays (weekly off)
) AS t;

-- Verify: expect 2 workers x 17 days (19 days minus 2 Sundays) = 34 rows.
SELECT worker_id, COUNT(*) AS days, MIN(date) AS from_day, MAX(date) AS to_day,
       MIN(punch_in_time) FILTER (WHERE status = 'late') AS sample_in,
       status, COUNT(*) FILTER (WHERE status = 'late') AS late_count
FROM attendance
WHERE worker_id IN (
  '0b6af56d-512c-4ffc-a671-a27ad7c7bfe0'::uuid,
  '766fc6ea-9102-45d9-9475-812287d1bbd7'::uuid
)
AND date BETWEEN '2026-09-01' AND '2026-09-19'
GROUP BY worker_id, status
ORDER BY worker_id, status;
