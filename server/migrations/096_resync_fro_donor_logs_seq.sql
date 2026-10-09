-- 096: Resync fro_donor_logs id sequence past its highest existing id.
--
-- CAUSE: some rows in fro_donor_logs were written with an explicit id (a data
-- migration/import) without resetting the sequence. As a result the sequence's
-- last_value fell behind MAX(id), so the next default-sequence INSERT produced
-- an id that already existed and failed with:
--
--   duplicate key value violates unique constraint "fro_donor_logs_pkey"
--
-- This surfaced on the FRO suspense claim (and any FRO disposition save) right
-- after such an import while the sequence was still catching up.
--
-- FIX: set the sequence to GREATEST(MAX(id), last_value) with is_called=true,
-- so the next nextval returns MAX(id)+1 (or last_value+1 if already higher).
-- This is idempotent: it never moves the sequence backward, so it can be
-- re-run safely any time; run it again after a future explicit-id import.
--
-- Runtime guard: the application now also calls ensureLogSequenceHealth()
-- before inserting into fro_donor_logs so future drift self-heals, but this
-- baseline resync makes the sequence correct right now without relying on that.

SELECT setval('fro_donor_logs_id_seq', (
  SELECT GREATEST(
    COALESCE((SELECT MAX(id) FROM fro_donor_logs), 0),
    (SELECT last_value FROM fro_donor_logs_id_seq)
  )
)::bigint, true);
