import db from '../config/db.js';

// Reminder push schema bootstrap — mirrors migrations 139 and 141. Re-runs
// safely on every boot (IF NOT EXISTS), so the reminder device-token table,
// the alert dedupe log, and the remind_days_before column are repaired
// automatically without manual SQL.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS reminder_device_tokens (
     id          BIGSERIAL PRIMARY KEY,
     token       TEXT UNIQUE NOT NULL,
     device_type TEXT DEFAULT 'flutter',
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS reminder_alert_log (
     id          BIGSERIAL PRIMARY KEY,
     reminder_id BIGINT REFERENCES reminders(id) ON DELETE CASCADE,
     alert_type  TEXT,
     sent_date   DATE NOT NULL DEFAULT CURRENT_DATE,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (reminder_id, alert_type, sent_date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reminder_alert_log_sent ON reminder_alert_log (sent_date)`,
];

export async function ensureReminderPushSchema() {
  try {
    const { rows } = await db._pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reminders'`
    );
    const hasReminders = rows.length > 0;

    if (hasReminders) {
      await db._pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS remind_days_before integer`);
      await db._pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS transaction_id text`);
      await db._pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS paid_by text`);
    }

    for (const s of STATEMENTS) {
      await db._pool.query(s);
    }
  } catch (e) {
    console.warn('[reminder push schema] skip:', e?.message || String(e));
  }
}