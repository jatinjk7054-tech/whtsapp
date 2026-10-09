-- 174: station_donor_deletions — audit trail for admin-initiated station donor removal.
--
-- WHY. The NGO admin Station Management tab can now remove a wrongly-duplicated
-- donor from a station (the "one active assignment per (donor_id, ngo_id)" rule in
-- add_assignment_dedup_index.sql). That removal HARD-deletes the station's
-- fro_assignments row plus its logs, scheduled contacts, rejected-lead tickets and
-- work_queue rows.
--
-- Hard deletion is exactly what migration 165 walked away from, and for a good
-- reason. Its header records that when the DND disposition used to DELETE the
-- assignment and its logs "a DND'd donor left no trace anywhere: the lead could
-- not be explained, audited or released", which produced "where did my data go"
-- reports. This table is the answer for the admin path: the lead still leaves the
-- station, but who removed it, when, from which station, and exactly how much was
-- cascaded away is all recorded here, so the removal can be explained and audited.
--
-- The distinction from 165 is scope. DND is a per-donor, high-frequency,
-- system-initiated decision, so it soft-marks and keeps the assignment visible.
-- This is a low-frequency, deliberate admin cleanup of a lead the admin believes
-- was duplicated onto the station in the first place, and the backend refuses to
-- delete any donor carrying collected money or a receipt. So nothing financial and
-- nothing already reconciled is destroyed here.
--
-- Snapshot columns (donor_name, mobile_number, status_at_delete, ...) are
-- deliberate COPIES, not foreign keys. donor_profiles and workers outlive the
-- assignment row and may be edited or deleted later; an audit row that joined back
-- to them would silently rewrite history. assignment_id is likewise a bare integer
-- with no FK — the row it points at is gone by definition.

CREATE TABLE IF NOT EXISTS station_donor_deletions (
  id                  bigserial PRIMARY KEY,
  -- The fro_assignments row that was removed. No FK: it no longer exists.
  assignment_id       integer      NOT NULL,
  donor_id            integer      NOT NULL REFERENCES donor_profiles(id) ON DELETE CASCADE,
  ngo_id              uuid         REFERENCES ngos(id) ON DELETE SET NULL,
  station             text,
  -- Which FRO held the lead when it was removed. ON DELETE SET NULL rather than
  -- CASCADE: losing the worker must not erase the record that they held it.
  fro_worker_id       uuid         REFERENCES workers(id) ON DELETE SET NULL,
  -- Denormalised copies, frozen at deletion time.
  donor_name          text,
  mobile_number       text,
  data_category       text,
  status_at_delete    text,
  batch_type          text,
  -- Cascade tallies, so an audit can tell "removed a clean untouched lead" from
  -- "removed a lead that had 40 disposition logs". Not constraints, just evidence.
  logs_deleted        integer NOT NULL DEFAULT 0,
  schedules_deleted   integer NOT NULL DEFAULT 0,
  tickets_deleted     integer NOT NULL DEFAULT 0,
  queue_rows_deleted  integer NOT NULL DEFAULT 0,
  -- True when the donor also had an active donor_dnd mark for this (donor, ngo).
  -- Deleting the assignment does NOT release that mark, and the mark is scoped to
  -- (donor_id, ngo_id) (165), so the number can stay suppressed after the row is
  -- gone. This flag tells an auditor that the removal did not fully un-suppress it.
  had_dnd_mark        boolean NOT NULL DEFAULT false,
  -- WHO removed it. Deliberately TEXT with no FK, unlike the rest of this table.
  --
  -- req.user.id is not a users.id. An NGO admin signs in through the workers table
  -- (authController.js maps department 'ngo admin' to role 'admin' and puts
  -- worker.id in the token), so their id is a workers uuid that does not exist in
  -- users — `REFERENCES users(id)` would reject every real deletion with a foreign
  -- key violation. The env-configured super admin is worse: their token carries the
  -- literal id 0 (authController.js:221), which is not a uuid at all and fails the
  -- cast outright. Migration 120 hit the same wall for notices.created_by.
  --
  -- No FK is also the correct behaviour for an audit trail: the point of the row is
  -- to still be able to answer "who did this" after the account is deleted or
  -- renamed. So the id is stored as text and the human-readable identity is
  -- snapshotted alongside it.
  deleted_by          text,
  deleted_by_name     text,
  deleted_by_role     text,
  deleted_by_email    text,
  deleted_at          timestamptz NOT NULL DEFAULT now()
);

-- "What did we delete from this station, and when?" — the support question this
-- table exists to answer.
CREATE INDEX IF NOT EXISTS idx_station_donor_deletions_station
  ON station_donor_deletions (station, deleted_at DESC);

-- "What did THIS admin remove?" — the abuse / accident question.
CREATE INDEX IF NOT EXISTS idx_station_donor_deletions_actor
  ON station_donor_deletions (deleted_by, deleted_at DESC);

-- Reconstructing one donor's removal history without scanning the whole table.
-- Not unique: the same donor can legitimately be removed and re-assigned and
-- removed again, and each of those is a distinct event worth keeping.
CREATE INDEX IF NOT EXISTS idx_station_donor_deletions_donor
  ON station_donor_deletions (donor_id, ngo_id, deleted_at DESC);
