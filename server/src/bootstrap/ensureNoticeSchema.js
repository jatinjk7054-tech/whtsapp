import db from '../config/db.js';

// Idempotent bootstrap for extra notice columns: media attachment, popup flag
// and multi-panel targeting. The `notices` table itself is created in the DB;
// these ALTERs simply add the new fields safely on existing installations.
const ENSURE_COLUMNS_SQL = `
ALTER TABLE notices ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS media_name TEXT;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS popup BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS target_roles JSONB DEFAULT '["all"]';
CREATE TABLE IF NOT EXISTS notice_seen (
  id BIGSERIAL PRIMARY KEY,
  notice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (notice_id, user_id)
);
-- User ids are UUIDs (strings); these casts keep old/odd layouts safe.
ALTER TABLE notice_seen ALTER COLUMN notice_id TYPE TEXT USING notice_id::text;
ALTER TABLE notice_seen ALTER COLUMN user_id TYPE TEXT USING user_id::text;
`;

export async function ensureNoticeSchema() {
  try {
    await db._pool.query(ENSURE_COLUMNS_SQL);
    console.log('notices media/popup/target_roles columns ready; notice_seen table ready');
  } catch (e) {
    console.warn('[notice schema] skip:', e?.message || String(e));
  }
}