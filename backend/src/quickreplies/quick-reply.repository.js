import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 6 — Quick Replies: reusable snippets an agent inserts into the normal
 * composer. They are NOT Meta-approved templates, so they never leave the CRM
 * on their own — the agent still presses Send and the existing 24-hour policy
 * still decides whether free text may go out.
 */

/** Seeded once into an empty table (admins can delete them afterwards). */
export const DEFAULT_QUICK_REPLIES = [
  {
    title: 'Greeting',
    shortcut: '/greeting',
    category: 'Greeting',
    message:
      'Namaste! Thank you for contacting Being Sevak Charitable Trust. How may we help you?',
  },
  {
    title: 'Donation Thanks',
    shortcut: '/donation',
    category: 'Donation',
    message:
      'Thank you for your support. Your contribution helps us continue our seva.',
  },
  {
    title: 'Follow-up',
    shortcut: '/followup',
    category: 'Follow-up',
    message: 'Hello, we are following up regarding your previous message.',
  },
];

/** Suggested categories; the library also shows whatever categories exist. */
export const QUICK_REPLY_CATEGORIES = [
  'General',
  'Greeting',
  'Donation',
  'Follow-up',
  'Support',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsSchemaPath = path.join(here, '..', 'db', 'settings.schema.sql');

/** Adds the leading "/" and trims: agents may type "donation" or "/donation". */
export function normalizeShortcut(value) {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Applies settings.schema.sql and seeds the starter replies into an empty library. */
export async function ensureQuickReplies() {
  const sql = await readFile(settingsSchemaPath, 'utf8');
  await query(sql);

  const count = await query('SELECT COUNT(*)::int AS total FROM quick_replies');
  if (count.rows[0].total > 0) return;

  for (const entry of DEFAULT_QUICK_REPLIES) {
    await query(
      `INSERT INTO quick_replies (title, shortcut, category, message)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (LOWER(shortcut)) DO NOTHING`,
      [entry.title, entry.shortcut, entry.category, entry.message]
    );
  }
}

/**
 * Everyone signed in may read the library — agents need it to answer customers.
 * `search` matches shortcut, title, category and message text.
 */
export async function listQuickReplies(search = '') {
  const term = String(search ?? '').trim();
  const result = term
    ? await query(
        `SELECT id, title, shortcut, category, message, created_by, created_at, updated_at
           FROM quick_replies
          WHERE shortcut ILIKE $1 OR title ILIKE $1 OR category ILIKE $1 OR message ILIKE $1
          ORDER BY shortcut`,
        [`%${term.replace(/[%_\\]/g, '\\$&')}%`]
      )
    : await query(
        `SELECT id, title, shortcut, category, message, created_by, created_at, updated_at
           FROM quick_replies
          ORDER BY shortcut`
      );
  return result.rows;
}

export async function getQuickReplyById(id) {
  const result = await query(
    `SELECT id, title, shortcut, category, message, created_by, created_at, updated_at
       FROM quick_replies WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** Case-insensitive lookup used to answer duplicates with a friendly 409. */
export async function findQuickReplyByShortcut(shortcut, exceptId = null) {
  const result = await query(
    `SELECT id, title, shortcut, category, message, created_by, created_at, updated_at
       FROM quick_replies
      WHERE LOWER(shortcut) = LOWER($1) AND ($2::int IS NULL OR id <> $2)`,
    [shortcut, exceptId]
  );
  return result.rows[0] ?? null;
}

export async function createQuickReply({ title, shortcut, category, message }, createdBy) {
  const result = await query(
    `INSERT INTO quick_replies (title, shortcut, category, message, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, shortcut, category, message, created_by, created_at, updated_at`,
    [title, normalizeShortcut(shortcut), category || 'General', message, createdBy ?? null]
  );
  return result.rows[0] ?? null;
}

/** Partial update — omitted fields keep their current value. */
export async function updateQuickReply(id, { title, shortcut, category, message }) {
  const result = await query(
    `UPDATE quick_replies
        SET title     = COALESCE($2, title),
            shortcut  = COALESCE($3, shortcut),
            category  = COALESCE($4, category),
            message   = COALESCE($5, message),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, title, shortcut, category, message, created_by, created_at, updated_at`,
    [
      id,
      title ?? null,
      shortcut === undefined ? null : normalizeShortcut(shortcut),
      category ?? null,
      message ?? null,
    ]
  );
  return result.rows[0] ?? null;
}

export async function deleteQuickReply(id) {
  const result = await query('DELETE FROM quick_replies WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}
