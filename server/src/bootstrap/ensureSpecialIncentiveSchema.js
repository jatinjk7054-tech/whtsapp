import db from '../config/db.js';

// Idempotent bootstrap for the "NGO wise Incentive" (special day incentive)
// tables. Ensures both tables exist on server start so the special-incentive
// flow (announce -> live leaderboard -> first-past-the-post winner) never
// fails on a fresh DB.
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS special_incentives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT,
  ngo_id UUID REFERENCES ngos(id) ON DELETE SET NULL,
  target_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  incentive_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winner_worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
  winner_claimed_at TIMESTAMPTZ,
  created_by UUID REFERENCES workers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS special_incentive_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  special_incentive_id UUID NOT NULL REFERENCES special_incentives(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  collected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  hit_target_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(special_incentive_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_special_incentives_status ON special_incentives(status);
CREATE INDEX IF NOT EXISTS idx_special_incentive_progress_inc ON special_incentive_progress(special_incentive_id);

ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS winner_name TEXT;
-- NGO-scoped incentives: pick one NGO (BSCT/AFLF/MANN) and only that NGO's
-- station FROs see & compete. NULL = org-wide race (all FROs).
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS ngo_id UUID REFERENCES ngos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_special_incentives_ngo_id ON special_incentives(ngo_id);

-- Winner photo celebration ("Photo" tab): Super Admin posts the winner's photo
-- with an (optional AI-generated) congratulation, which pops up on every panel.
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS winner_photo_url TEXT;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS congrats_message TEXT;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS celebrated_at TIMESTAMPTZ;

-- Archive: admins can archive a resolved incentive so its winner/photo popups
-- stop being delivered to panels entirely.
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE special_incentives ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES workers(id) ON DELETE SET NULL;
`;

const LEAD_INCENTIVE_SQL = `
CREATE TABLE IF NOT EXISTS incentive_slabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  min_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  incentive_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  min_lead_amount NUMERIC(12,2) NOT NULL DEFAULT 300,
  lead_rate NUMERIC(12,2) NOT NULL DEFAULT 20,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Self-heal for older DBs: add per-slab columns (ADD COLUMN ... DEFAULT fills
-- existing rows with the sane baseline; migration 124 copies the then-current
-- global values across once).
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS min_lead_amount NUMERIC(12,2) NOT NULL DEFAULT 300;
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS lead_rate NUMERIC(12,2) NOT NULL DEFAULT 20;
-- Admin "⏹ Stop competition" for today: when set (= a date), the range is
-- hidden from the FRO-facing live leaderboard for that date, without deleting
-- the slab. Restarting the competition (configure / apply-all / announce)
-- clears it.
-- Flat-prize "first to collect ₹X today wins" target: the total verified day
-- collection a FRO must reach (by verified_at) to win the range's flat prize
-- (incentive_amount). amount_to_win is the only qualification a range needs;
-- every verified lead counts toward it (no per-lead minimum).
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS amount_to_win NUMERIC(12,2) NOT NULL DEFAULT 1500;
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS stopped_date DATE;
-- Competition window (like "NGO wise Incentive"): started_at = when the range's
-- competition begins, ended_at = when it ends. NULL started_at = not started yet;
-- NULL ended_at = runs until stopped/end of day. Leads verified outside the
-- window never count. Set via the ⏱ Start/End Time controls (all or single range).
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE incentive_slabs ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS incentive_settings (
  id SERIAL PRIMARY KEY,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incentive_slabs_active ON incentive_slabs(is_active);
CREATE INDEX IF NOT EXISTS idx_incentive_settings_key ON incentive_settings(setting_key);

INSERT INTO incentive_settings (setting_key, setting_value) VALUES
  ('lead_rate', 20),
  ('min_lead_amount', 300),
  ('champion_bonus', 250)
ON CONFLICT (setting_key) DO NOTHING;

-- Only seed slabs if table is empty (prevents duplicates on restart)
INSERT INTO incentive_slabs (min_amount, max_amount, incentive_amount)
SELECT * FROM (VALUES
  (1, 20000, 0),
  (20000, 50000, 500),
  (50000, 80000, 1000),
  (80000, 135000, 2000),
  (135000, 200000, 3500),
  (200000, 350000, 5000)
) AS v(min_amount, max_amount, incentive_amount)
WHERE NOT EXISTS (SELECT 1 FROM incentive_slabs LIMIT 1);
`;

// Unique (min_amount, max_amount) index. Created AFTER the dedupe self-heal runs,
// because an older deployment could have seeded duplicate ranges (no index back
// then) — the index creation would fail on those duplicates until they are cleaned.
const LEAD_UNIQUE_RANGE_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_incentive_slabs_range ON incentive_slabs(min_amount, max_amount);
`;

// Self-heal: guarantee the low lead band exists as an ACTIVE ₹1–₹20,000 slab.
// The UI/API only lists is_active=true slabs, so if the low band row is missing
// or was soft-deleted (is_active=false), the "1 to 20k" range silently vanishes
// and re-adding it hits the unique (min_amount, max_amount) index. This block
// repairs all three states at every backend start:
//   1) (1, 20000) exists (active or inactive)  -> reactivate
//   2) legacy (0, 20000) row exists            -> migrate to (1, 20000), reactivate
//   3) no low band at all                      -> insert a new (1, 20000) slab
// It also de-duplicates ranges: an older deployment could have seeded the same
// (min_amount, max_amount) more than once, which made the UI list every range
// twice. One row is kept per range (an active one if any exists), the extra
// duplicate rows are permanently deleted so the unique index can be created
// (no other table references incentive_slabs by id).
const LEAD_LOW_RANGE_SELF_HEAL_SQL = `
UPDATE incentive_slabs SET is_active = true, updated_at = now()
 WHERE min_amount = 1 AND max_amount = 20000;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM incentive_slabs WHERE min_amount = 1 AND max_amount = 20000) THEN
    UPDATE incentive_slabs
       SET min_amount = 1, max_amount = 20000, is_active = true, updated_at = now()
     WHERE id = (
       SELECT id FROM incentive_slabs
       WHERE min_amount = 0 AND max_amount = 20000
       ORDER BY created_at ASC
       LIMIT 1
     );
  END IF;
END $$;

INSERT INTO incentive_slabs (min_amount, max_amount, incentive_amount, min_lead_amount, lead_rate, is_active)
SELECT 1, 20000, 0,
       COALESCE((SELECT setting_value FROM incentive_settings WHERE setting_key = 'min_lead_amount'), 300),
       COALESCE((SELECT setting_value FROM incentive_settings WHERE setting_key = 'lead_rate'), 20),
       true
WHERE NOT EXISTS (SELECT 1 FROM incentive_slabs WHERE min_amount = 1 AND max_amount = 20000);

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY min_amount, max_amount
                            ORDER BY (is_active) DESC, created_at ASC, id ASC) AS rn
  FROM incentive_slabs
)
DELETE FROM incentive_slabs WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
`;

const CHAMPION_ANNOUNCEMENT_SQL = `
CREATE TABLE IF NOT EXISTS lead_champion_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_date DATE NOT NULL,
  slab_id UUID,
  slab_label TEXT,
  fro_worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
  fro_name TEXT,
  total_leads INT DEFAULT 0,
  qualified_leads INT DEFAULT 0,
  total_amount NUMERIC(12,2) DEFAULT 0,
  lead_incentive NUMERIC(12,2) DEFAULT 0,
  slab_bonus NUMERIC(12,2) DEFAULT 0,
  champion_bonus NUMERIC(12,2) DEFAULT 0,
  total_incentive NUMERIC(12,2) DEFAULT 0,
  message TEXT,
  announced_by UUID REFERENCES workers(id) ON DELETE SET NULL,
  announced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Older DBs: add the per-range columns and relax the date-only uniqueness so a
-- date can hold one winner PER RANGE (each range runs its own competition).
ALTER TABLE lead_champion_announcements ADD COLUMN IF NOT EXISTS slab_id UUID;
ALTER TABLE lead_champion_announcements ADD COLUMN IF NOT EXISTS slab_label TEXT;
-- Winner celebration: uploaded winner photo + published congrats popup
-- (celebrated_at set once when Super Admin hits Send; never rewritten).
ALTER TABLE lead_champion_announcements ADD COLUMN IF NOT EXISTS winner_photo_url TEXT;
ALTER TABLE lead_champion_announcements ADD COLUMN IF NOT EXISTS celebrated_at TIMESTAMPTZ;
-- Snapshot the range's competition window so History can show start/end time.
ALTER TABLE lead_champion_announcements ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE lead_champion_announcements ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
-- Backfill older announcements (no-op when nothing to fill).
UPDATE lead_champion_announcements a
SET started_at = s.started_at, ended_at = s.ended_at
FROM incentive_slabs s
WHERE a.slab_id = s.id
  AND s.started_at IS NOT NULL
  AND (a.started_at IS NULL OR a.ended_at IS NULL);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'lead_champion_announcements'::regclass
               AND conname = 'lead_champion_announcements_announcement_date_key') THEN
    ALTER TABLE lead_champion_announcements DROP CONSTRAINT lead_champion_announcements_announcement_date_key;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lead_champion_date ON lead_champion_announcements(announcement_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_champion_date_slab ON lead_champion_announcements(announcement_date, slab_id);

-- Which FROs compete in which range (set from the ⚙️ Configure popup). FROs left
-- unassigned still fall into a range automatically via their monthly target.
CREATE TABLE IF NOT EXISTS incentive_slab_fros (
  slab_id UUID NOT NULL REFERENCES incentive_slabs(id) ON DELETE CASCADE,
  fro_worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (slab_id, fro_worker_id)
);
CREATE INDEX IF NOT EXISTS idx_incentive_slab_fros_slab ON incentive_slab_fros(slab_id);
CREATE INDEX IF NOT EXISTS idx_incentive_slab_fros_fro ON incentive_slab_fros(fro_worker_id);
`;

export const ensureLowLeadRangeActive = async () => {
  await db._pool.query(LEAD_LOW_RANGE_SELF_HEAL_SQL);
};

export async function ensureSpecialIncentiveSchema() {
  try {
    await db._pool.query(CREATE_TABLE_SQL);
    console.log('special_incentives tables ready');
  } catch (e) {
    console.warn('[special incentive schema] skip:', e?.message || String(e));
  }
  try {
    await db._pool.query(LEAD_INCENTIVE_SQL);
    // Self-heal + de-dupe first, then the unique (min_amount, max_amount) index
    // can be built safely on a DB that still has duplicate range rows.
    await ensureLowLeadRangeActive();
    await db._pool.query(LEAD_UNIQUE_RANGE_INDEX_SQL);
    console.log('incentive_slabs + incentive_settings tables ready');
  } catch (e) {
    console.warn('[lead incentive schema] skip:', e?.message || String(e));
  }
  try {
    await db._pool.query(CHAMPION_ANNOUNCEMENT_SQL);
    console.log('lead_champion_announcements table ready');
  } catch (e) {
    console.warn('[lead champion schema] skip:', e?.message || String(e));
  }
}