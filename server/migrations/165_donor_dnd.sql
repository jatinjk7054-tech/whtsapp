-- 165: donor_dnd — an explicit, durable "do not contact" registry.
--
-- The problem this solves: when a FRO marked a donor DND, froController deleted
-- the fro_assignments row, its fro_donor_logs rows and its scheduled contacts.
-- Nothing recorded the decision, so a DND'd donor left no trace anywhere: the
-- lead could not be explained, audited or released, and there was no table to
-- ask "is this donor suppressed?" This migration gives that decision a home.
--
-- Scope is deliberately (donor_id, ngo_id) and NOT donor_id alone. 41,015
-- donors in this system are assigned to more than one NGO (up to 3), and every
-- one of the 350 donors backfilled below is also live at other stations. A
-- global (donor_id) suppression would therefore silently strip donors from
-- stations and NGOs whose FROs never marked them DND — reproducing exactly the
-- "where did my data go" problem this table is meant to end. A DND mark is a
-- decision made by one FRO at one NGO, so it suppresses that scope only.
--
-- released_at IS NULL means the donor is currently suppressed. Releasing a DND
-- (rather than deleting the row) keeps the audit trail: who marked it, when,
-- and why.

create table if not exists public.donor_dnd (
  id          bigserial primary key,
  donor_id    integer     not null references public.donor_profiles(id) on delete cascade,
  ngo_id      uuid        references public.ngos(id) on delete cascade,
  station     text,
  reason      text        not null default 'dnd',
  note        text,
  marked_by   uuid        references public.workers(id) on delete set null,
  marked_at   timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid        references public.workers(id) on delete set null,
  source      text        not null default 'manual'
                -- 'manual'  = marked via the FRO disposition / status flow
                -- 'backfill'= recovered from pre-existing status or disposition
  constraint donor_dnd_reason_not_blank check (length(btrim(reason)) > 0)
);

-- One active DND per (donor, NGO). Partial so a donor can be DND'd again after
-- a release without the old history blocking the new mark.
create unique index if not exists uq_donor_dnd_active
  on public.donor_dnd (donor_id, ngo_id)
  where released_at is null;

-- The My Leads read path filters on (ngo_id, donor_id) and only ever wants the
-- active rows, so lead with ngo_id to keep the index small and ordered.
create index if not exists idx_donor_dnd_active_ngo_donor
  on public.donor_dnd (ngo_id, donor_id)
  where released_at is null;

-- Backfill from BOTH places a DND can already be evidenced:
--   1. fro_assignments.status = 'dnd'        (the status dropdown path)
--   2. a 'dnd' disposition in fro_donor_logs (the disposition modal path)
-- Source 2 is not redundant: 11 of the BOD-15 rows have a dnd disposition log
-- without status ever having been set, and skipping them would leave donors
-- visible who were explicitly marked DND.
--
-- Only 'dnd' is backfilled. Terminal dispositions such as not_interested,
-- call_disconnected or wrong_number are NOT DND — those remain ordinary worked
-- leads that stay visible in My Leads.
--
-- ngo_id is never null in the current data, but coalesce() keeps a same-donor
-- mark under a NULL ngo from colliding with a scoped one on the unique index.
insert into public.donor_dnd (donor_id, ngo_id, station, reason, marked_by, marked_at, source)
select u.donor_id,
       u.ngo_id,
       u.station,
       'dnd',
       u.marked_by,
       u.marked_at,
       'backfill'
from (
  select a.donor_id,
         a.ngo_id,
         a.station,
         a.fro_worker_id as marked_by,
         a.assigned_at   as marked_at
    from public.fro_assignments a
   where a.status = 'dnd'
  union
  select l.donor_id,
         a.ngo_id,
         a.station,
         l.fro_worker_id as marked_by,
         l.created_at    as marked_at
    from public.fro_donor_logs l
    join public.fro_assignments a on a.id = l.assignment_id
   where l.action = 'disposition'
     and l.disposition_detail = 'dnd'
) u
where u.donor_id is not null
on conflict (donor_id, ngo_id) where released_at is null do nothing;