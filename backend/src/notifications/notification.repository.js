import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 10 — persistence for the per-staff notification feed.
 *
 * Both `notifications` and `reminders` live in reminders.schema.sql; applying
 * it here (idempotently) means this module can be loaded on its own, e.g. by
 * the test suite, without depending on boot order.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const remindersSchemaPath = path.join(here, '..', 'db', 'reminders.schema.sql');

export async function ensureNotificationsSchema() {
  const sql = await readFile(remindersSchemaPath, 'utf8');
  await query(sql);
}

export function normalizeNotification(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    conversationId: row.conversation_id,
    reminderId: row.reminder_id,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    isRead: Boolean(row.read_at),
    createdAt: row.created_at,
  };
}

/**
 * Inserts one notification per recipient. `ON CONFLICT (staff_id, dedupe_key)
 * DO NOTHING` is the idempotency guard: Meta retries and repeated sweeps can
 * call this as often as they like and only the first insert wins.
 *
 * Returns the number of rows actually created.
 */
export async function insertNotifications(rows) {
  if (!rows || rows.length === 0) return 0;

  const values = [];
  const tuples = rows.map((row) => {
    values.push(
      row.staffId,
      row.type,
      row.conversationId ?? null,
      row.reminderId ?? null,
      row.title ?? '',
      row.body ?? '',
      row.dedupeKey
    );
    const end = values.length;
    return `($${end - 6}, $${end - 5}, $${end - 4}, $${end - 3}, $${end - 2}, $${end - 1}, $${end})`;
  });

  const result = await query(
    `INSERT INTO notifications
       (staff_id, type, conversation_id, reminder_id, title, body, dedupe_key)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (staff_id, dedupe_key) DO NOTHING
     RETURNING id`,
    values
  );
  return result.rowCount;
}

export async function listNotifications(staffId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  const values = [staffId];
  let where = 'WHERE staff_id = $1';
  if (unreadOnly) where += ' AND read_at IS NULL';

  values.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const limitIdx = values.length;
  values.push(Math.max(Number(offset) || 0, 0));
  const offsetIdx = values.length;

  const result = await query(
    `SELECT * FROM notifications
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );
  return result.rows.map(normalizeNotification);
}

export async function countUnread(staffId) {
  const result = await query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE staff_id = $1 AND read_at IS NULL',
    [staffId]
  );
  return result.rows[0]?.count ?? 0;
}

export async function markRead(staffId, id) {
  const result = await query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE id = $1 AND staff_id = $2 AND read_at IS NULL
      RETURNING id`,
    [id, staffId]
  );
  return result.rowCount > 0;
}

export async function markAllRead(staffId) {
  const result = await query(
    'UPDATE notifications SET read_at = NOW() WHERE staff_id = $1 AND read_at IS NULL',
    [staffId]
  );
  return result.rowCount;
}

export async function getNotification(staffId, id) {
  const result = await query('SELECT * FROM notifications WHERE id = $1 AND staff_id = $2', [id, staffId]);
  return normalizeNotification(result.rows[0]);
}
