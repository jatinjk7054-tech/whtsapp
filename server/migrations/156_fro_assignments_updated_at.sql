-- 156: give fro_assignments the updated_at column the code already writes
--
-- WHY. Seven call sites update fro_assignments with an updated_at in the
-- payload, and the column has never existed on the table:
--
--   notificationScheduler.js  resetCycledDonors      -> status: 'pending'
--   accountsController.js:3542                        -> status: 'pending'
--   accountsController.js:3614                        -> status: 'pending'
--   accountsController.js:4919                        -> status: 'reassigned'
--   froAssignmentModel.js:180 / :327 / :373           -> status: 'reassigned'
--
-- PostgREST rejects the whole statement, so every one of those updates has
-- been a no-op that changed nothing. Two of them are wrapped in a try/catch
-- that logs and continues, which is why this went unnoticed: the nightly
-- donor-cycle reset logged
--
--   [resetCycledDonors] Error: column "updated_at" of relation
--   "fro_assignments" does not exist
--
-- once a day and carried on. 2,464 assignments are currently sitting in
-- donation_collected from periods that should already have rolled back to
-- pending. The four 'reassigned' sites are station/batch transfer paths, so
-- those transfers have been leaving rows in a stale status too.
--
-- THE FIX. Add the column rather than delete updated_at from the seven
-- payloads. Dropping it would make the statements succeed while losing the
-- only record of when a status last changed, and these are exactly the
-- transitions - a donor marked collected, a lead handed to another station -
-- where that timestamp is worth having. One migration repairs all seven
-- paths and future ones.
--
-- Backfilled from last_contacted_at, falling back to assigned_at, so existing
-- rows get the date the assignment was last actually touched rather than a
-- meaningless migration timestamp. NULL where neither is known, which sorts
-- as 'never changed' rather than as now.

ALTER TABLE fro_assignments
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE fro_assignments
   SET updated_at = COALESCE(last_contacted_at, assigned_at)
 WHERE updated_at IS NULL;

COMMENT ON COLUMN fro_assignments.updated_at IS
  'Last time the assignment row was written (status change, transfer, or contact).';
