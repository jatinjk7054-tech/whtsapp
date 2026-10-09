-- 154: SIM Management schema sync.
--
-- WHY: the SIM panel's Add forms post owner, ngo, w1_name, gb, sim_type and
-- sim_1..sim_20 in a single payload, and the data layer builds a literal
-- INSERT/UPDATE from whatever keys it is given. Postgres rejects the WHOLE
-- statement when any one of them is not a real column, so an installation
-- missing a single column failed the entire save. sim_cards has no boot-time
-- self-healing (only sim_inventory does, via ensureSimInventorySchema), so a
-- missing column was fatal until a migration added it.
--
-- This adds every column the SIM section reads or writes, so the panel is
-- complete no matter which of 089/103/105/110/113/114/117 actually ran. It is
-- a pure convergence migration: no row is read, written or deleted.
--
-- NOT added on purpose: 'owner_name'. That is the Add-to-Locker form field's
-- name for the 'assigned_to' column, not a column of its own - the Locker UI
-- reads assigned_to. Creating it would leave a second, permanently NULL copy of
-- the owner's name. The reason it reached Postgres at all is fixed in
-- simInventoryController.js, which now filters the payload to a known column
-- list - see the comment there.
--
-- DELIBERATELY no DO block and no procedural IF. An earlier revision wrapped
-- this in a DO block guarded with to_regclass() and END IF, which failed with
-- "syntax error at or near IF" on any runner that splits the file on
-- semicolons: the block got shredded and the parser met END IF outside a
-- function. Each statement below is a single complete top-level statement,
-- which is safe
-- under semicolon-splitting runners, whole-file pool.query(), and a manual
-- paste into psql/pgAdmin alike. Every one is independently idempotent
-- (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), so re-running is
-- a no-op and a partial run is repaired by running again. DO NOT wrap this in
-- a DO block to "also" skip missing tables: both tables are created by 086/088
-- and a hard error if one is absent is the correct, visible signal.
--
-- Also deliberately NOT included: any DROP NOT NULL. sim_cards.status and
-- sim_inventory.sim_number are tightened by 086/088 on purpose - relaxing them
-- to paper over a bad value would silently change the schema contract.

-- sim_cards: converge the column set
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS mobile_id text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS device_model text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS imei text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS team text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS signature text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS issue_date date;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS expiry_date date;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS replacement_count integer DEFAULT 0;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_type text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS gb text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS ngo text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS owner text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS calling_mobile text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS use_for text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS team_leader_name text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS user_name text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS days_left integer;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS remark text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS w1_name text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS w2_name text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS w3_name text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS w4_name text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_1 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_2 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_3 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_4 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_5 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_6 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_7 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_8 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_9 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_10 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_11 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_12 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_13 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_14 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_15 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_16 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_17 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_18 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_19 text;
ALTER TABLE public.sim_cards ADD COLUMN IF NOT EXISTS sim_20 text;

-- sim_inventory: converge the column set
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS sim_name text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS sim_number text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS sim_type text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS mobile_id text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS device text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS imei text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS assigned_to text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS team text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS assignment_date date;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS issue_date date;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS expiry_date date;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.sim_inventory ADD COLUMN IF NOT EXISTS created_by text;

-- Indexes for the columns the SIM tables filter and sort on. Created after
-- the ADD COLUMNs so the indexed column always exists first.
CREATE INDEX IF NOT EXISTS idx_sim_cards_expiry ON public.sim_cards(expiry_date);
CREATE INDEX IF NOT EXISTS idx_sim_cards_status ON public.sim_cards(status);
CREATE INDEX IF NOT EXISTS idx_sim_cards_mobile_id ON public.sim_cards(mobile_id);
CREATE INDEX IF NOT EXISTS idx_sim_inventory_status ON public.sim_inventory(status);
CREATE INDEX IF NOT EXISTS idx_sim_inventory_sim_number ON public.sim_inventory(sim_number);
CREATE INDEX IF NOT EXISTS idx_sim_inventory_expiry ON public.sim_inventory(expiry_date);
