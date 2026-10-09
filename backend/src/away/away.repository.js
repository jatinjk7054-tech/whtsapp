import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 6 — the single global Away Message configuration.
 *
 * One row (id = 1) for the whole CRM: agents never get their own copy. The
 * schedule lives as JSONB because it is read and written as a whole by one
 * admin form; `away.service.js` interprets it against the configured IANA
 * timezone.
 */

/** 0 = Sunday … 6 = Saturday, matching JS `Date#getDay()` and Intl weekday. */
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DEFAULT_AWAY_MESSAGE =
  'Thank you for contacting Being Sevak Charitable Trust.\n' +
  'Our team is currently unavailable.\n' +
  'We will get back to you as soon as possible.';

/** Weekdays 09:00–18:00, weekends off — the state a fresh install starts in. */
export const DEFAULT_SCHEDULE = [
  { day: 1, enabled: true, from: '09:00', to: '18:00' },
  { day: 2, enabled: true, from: '09:00', to: '18:00' },
  { day: 3, enabled: true, from: '09:00', to: '18:00' },
  { day: 4, enabled: true, from: '09:00', to: '18:00' },
  { day: 5, enabled: true, from: '09:00', to: '18:00' },
  { day: 6, enabled: false, from: '09:00', to: '18:00' },
  { day: 0, enabled: false, from: '09:00', to: '18:00' },
];

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsSchemaPath = path.join(here, '..', 'db', 'settings.schema.sql');

/**
 * Applies settings.schema.sql and makes sure the single settings row exists.
 * Idempotent and run at boot, so a database created before Module 6 gains the
 * table (and the sensible defaults) without anyone re-running the migration.
 */
export async function ensureAwaySettings() {
  const sql = await readFile(settingsSchemaPath, 'utf8');
  await query(sql);

  await query(
    `INSERT INTO away_message_settings (id, enabled, message, timezone, schedule)
     VALUES (1, FALSE, $1, $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_AWAY_MESSAGE, DEFAULT_TIMEZONE, JSON.stringify(DEFAULT_SCHEDULE)]
  );
}

function normalizeRow(row) {
  if (!row) return null;
  let schedule = row.schedule;
  if (typeof schedule === 'string') {
    try {
      schedule = JSON.parse(schedule);
    } catch {
      schedule = [];
    }
  }
  // Module 9: public holidays / closed days, an array of 'YYYY-MM-DD' strings.
  let holidays = row.holidays;
  if (typeof holidays === 'string') {
    try {
      holidays = JSON.parse(holidays);
    } catch {
      holidays = [];
    }
  }
  return {
    id: row.id,
    enabled: Boolean(row.enabled),
    message: row.message ?? '',
    timezone: row.timezone || DEFAULT_TIMEZONE,
    schedule: Array.isArray(schedule) ? schedule : [],
    holidays: Array.isArray(holidays) ? holidays : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getAwaySettings() {
  const result = await query('SELECT * FROM away_message_settings WHERE id = 1');
  if (result.rows[0]) return normalizeRow(result.rows[0]);

  // A webhook can beat the boot-time seed on a brand-new database. Rather than
  // crash (or silently skip the away message forever), create the defaults now.
  await ensureAwaySettings();
  const retry = await query('SELECT * FROM away_message_settings WHERE id = 1');
  return normalizeRow(retry.rows[0]);
}

/** Partial update; every field keeps its current value when omitted. */
export async function updateAwaySettings({ enabled, message, timezone, schedule, holidays }) {
  const result = await query(
    `UPDATE away_message_settings
        SET enabled     = COALESCE($2, enabled),
            message     = COALESCE($3, message),
            timezone    = COALESCE($4, timezone),
            schedule    = COALESCE($5::jsonb, schedule),
            holidays    = COALESCE($6::jsonb, holidays),
            updated_at  = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      1,
      enabled === undefined ? null : Boolean(enabled),
      message === undefined ? null : message,
      timezone ?? null,
      schedule === undefined ? null : JSON.stringify(schedule),
      holidays === undefined ? null : JSON.stringify(holidays),
    ]
  );
  return normalizeRow(result.rows[0]);
}

/**
 * Cooldown claim: marks the conversation as "away message sent" only when the
 * previous one is older than 24 hours (or never sent). The conditional UPDATE
 * makes two concurrent webhooks race for exactly one winner, so a customer
 * never receives two away messages from a burst of messages.
 * Returns true when this caller owns the send.
 */
export async function claimAwaySend(conversationId) {
  const result = await query(
    `UPDATE conversations
        SET last_away_sent_at = NOW()
      WHERE id = $1
        AND (last_away_sent_at IS NULL
             OR last_away_sent_at < NOW() - INTERVAL '24 hours')
      RETURNING id`,
    [conversationId]
  );
  return result.rowCount > 0;
}

/**
 * Gives the claim back when the send itself failed (Meta rejected it, network
 * blip), so the next genuine customer message can try again instead of waiting
 * out a 24-hour cooldown for a message that never went out.
 */
export async function releaseAwayClaim(conversationId) {
  await query('UPDATE conversations SET last_away_sent_at = NULL WHERE id = $1', [conversationId]);
}
