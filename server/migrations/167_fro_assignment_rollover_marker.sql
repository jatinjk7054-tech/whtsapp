-- 167: remember WHY a lead went back to 'pending' at the month boundary.
--
-- The monthly rollover (166) resets worked leads (ringing, busy, unreachable, …)
-- back to 'pending'. That overwrites fro_assignments.status, so without a marker
-- the FRO opening a freshly-reset lead sees a bare 'pending' and cannot tell
-- whether it is a genuinely new lead or a lead they already worked last month.
--
-- These two columns preserve that context: the status the row carried just
-- before the reset, and when the reset happened. getMyDonors surfaces them as a
-- row badge and getDonorLogs prepends a "monthly reset" entry to the CRM
-- timeline, so the previous status and the fact that it was a rollover reset stay
-- visible. The marker is cleared by updateAssignmentStatus the moment the FRO
-- dispositions the lead again (any status other than 'pending'), so it only ever
-- describes the most recent month boundary.
--
-- Nullable: existing rows and never-reset rows carry NULL and render no badge.

alter table public.fro_assignments
  add column if not exists rollover_from_status text,
  add column if not exists rollover_at timestamptz;

comment on column public.fro_assignments.rollover_from_status is
  'Status this assignment held immediately before the monthly rollover reset it to pending; NULL if never reset or already re-worked.';
comment on column public.fro_assignments.rollover_at is
  'When the monthly rollover reset this assignment to pending; NULL if never reset or already re-worked.';
