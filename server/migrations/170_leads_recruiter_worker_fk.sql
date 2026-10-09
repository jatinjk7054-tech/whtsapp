-- 170: point leads.recruiter_id at the table recruiters actually live in.
--
-- The problem
-- -----------
-- leads_recruiter_id_fkey read
--
--   FOREIGN KEY (recruiter_id) REFERENCES users(id) ON DELETE SET NULL
--
-- but recruiters are not users. They are rows in public.workers, with a uuid id,
-- and they authenticate through /auth/login -> getWorkerByLoginId, so the JWT
-- carries workers.id (authController.js maps department 'HR-Recruiter' -> role
-- 'recruiter'). The CRM has no recruiter-role rows in public.users at all.
--
-- Two consequences, both observed:
--
--   1. recruiter_id was 0 of 376 rows populated. HR's "Assigned to" dropdown
--      (client/src/panels/hr/components/Recruiters.jsx) is populated from
--      GET /recruiters -> getRecruiterWorkers() -> workers.id, so every
--      assignment it produced was a workers uuid that the users(id) foreign key
--      rejected. Assignment could never persist.
--
--   2. The embedded select in leadModel.js named the users table through the
--      constraint hint (users!leads_recruiter_id_fkey). PostgREST resolves that
--      hint from the constraint definition, so it only stays correct while the
--      constraint points at users -- and it has to move with the constraint.
--
-- Recreated under the SAME constraint name, so the hint in leadModel.js reads
-- 'workers!leads_recruiter_id_fkey' and resolves against this constraint without
-- any further renaming.
--
-- Why no data backfill
-- --------------------
-- There is none to do, and none is possible. The only plausible owner of an
-- orphaned lead is the recruiter who entered it, and every row already records
-- exactly that: all 376 rows have created_by set, to a workers uuid, agreeing
-- with created_by_name (356 Bhumika Rai, 20 Pooja Patel). Migration 169 tried to
-- backfill rows matching 'recruiter_id is null AND created_by is null', which is
-- the empty set here, and it keyed its lookup on public.users, which holds no
-- recruiters. It is superseded by this migration and removed rather than fixed.
--
-- Safety
-- ------
-- Idempotent, and re-applied on boot by bootstrap/ensureLeadsRecruiterFkSchema.js
-- because migrations are not auto-run in this repo. ON DELETE SET NULL is kept:
-- deleting a worker must orphan the lead in the recruiter's panel rather than
-- delete their pipeline.
--
-- Recreating the FK re-validates every existing recruiter_id. All of them are
-- NULL today, so this is a no-op scan, but the guard below turns a future orphan
-- into a named error naming the offending rows instead of an opaque constraint
-- violation, and refuses to guess an owner for them.

-- ── 0. Refuse rather than silently drop, if anything is already orphaned ──────
-- A recruiter_id pointing at neither users nor workers cannot satisfy either
-- target. This migration will not delete or reassign those rows -- that would
-- hand one recruiter a colleague's work -- so it stops and says which rows.
do $$
declare
  orphans integer;
begin
  select count(*) into orphans
    from public.leads l
   where l.recruiter_id is not null
     and not exists (select 1 from public.workers w where w.id = l.recruiter_id)
     and not exists (select 1 from public.users u where u.id = l.recruiter_id);

  if orphans > 0 then
    raise exception
      'leads.recruiter_id has % row(s) matching neither public.workers nor public.users; assign them by hand before running 170',
      orphans;
  end if;
end $$;

-- ── 1. Re-point the foreign key ──────────────────────────────────────────────
-- Dropped first because the target table changes; re-added with the same name so
-- the PostgREST hint in leadModel.js keeps resolving.
alter table public.leads drop constraint if exists leads_recruiter_id_fkey;

alter table public.leads
  add constraint leads_recruiter_id_fkey
  foreign key (recruiter_id) references public.workers(id) on delete set null;

comment on constraint leads_recruiter_id_fkey on public.leads is
  'The assigned recruiter. Targets public.workers, not public.users: recruiters are workers (uuid) and authenticate with workers.id in their JWT.';

-- ── 2. Indexes for the scoped read ───────────────────────────────────────────
-- getAllLeads() and getLeadsDashboard() filter through a single .or() over
-- recruiter_id / created_by and then order by created_at desc. Once a
-- recruiter's slice is small relative to the table, those two indexes are what
-- keep the read off a sequential scan.
--
-- Guarded per column because the file may run against a partially migrated
-- schema: a missing column would abort the statement, and these are only
-- optimisations, so skipping one is always safe.
do $$
declare
  has_recruiter_id boolean;
  has_created_by   boolean;
  has_creator_name boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads' and column_name = 'recruiter_id'
  ) into has_recruiter_id;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads' and column_name = 'created_by'
  ) into has_created_by;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'leads' and column_name = 'created_by_name'
  ) into has_creator_name;

  if has_recruiter_id then
    execute 'create index if not exists leads_recruiter_id_created_at_idx
               on public.leads (recruiter_id, created_at desc)';
  end if;
  if has_created_by then
    execute 'create index if not exists leads_created_by_created_at_idx
               on public.leads (created_by, created_at desc)';
  end if;
  if has_creator_name then
    -- Serves the lower(btrim(...)) audit and reporting queries. Postgres does not
    -- rewrite `created_by_name ILIKE 'x'` into an indexable lower() comparison,
    -- so this does NOT back the .or() name clause -- that one leans on the two id
    -- indexes plus the planner's judgement, and the clause is a fallback for rows
    -- that carry no id at all.
    execute 'create index if not exists leads_created_by_name_lower_idx
               on public.leads (lower(btrim(created_by_name)))';
  end if;
end $$;
