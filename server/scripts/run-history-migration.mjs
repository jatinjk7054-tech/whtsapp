// Apply migration 106: create the sim_card_history table (idempotent).
// Usage (from backend/):  node scripts/run-history-migration.mjs
import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import db from '../src/config/db.js';

const sql = `
CREATE TABLE IF NOT EXISTS sim_card_history (
  id bigserial PRIMARY KEY,
  sim_card_id bigint REFERENCES sim_cards(id) ON DELETE CASCADE,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_cols jsonb,
  before_data jsonb,
  after_data jsonb
);
CREATE INDEX IF NOT EXISTS idx_sim_card_history_card
  ON sim_card_history(sim_card_id);
CREATE INDEX IF NOT EXISTS idx_sim_card_history_changed_at
  ON sim_card_history(changed_at);
`;

try {
  await db._pool.query(sql);
  const verify = await db._pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name='sim_card_history'`
  );
  console.log('Migration 106 applied. sim_card_history exists:', verify.rows.length > 0);
  process.exit(0);
} catch (e) {
  console.error('Migration failed:', e.message);
  process.exit(1);
}