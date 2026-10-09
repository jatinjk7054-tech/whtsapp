import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 5 — customer tags.
 *
 * `tags` holds one row per label (name + colour), `contact_tags` holds the
 * many-to-many links to customers. Nothing about a tag is ever copied into a
 * contact or conversation row, so renaming a tag updates every list, profile
 * and filter at once.
 */

/** The five tags every deployment starts with (§15). */
export const DEFAULT_TAGS = [
  { name: 'New', color: '#16a34a' },
  { name: 'Donation', color: '#2563eb' },
  { name: 'Follow-up', color: '#eab308' },
  { name: 'Urgent', color: '#dc2626' },
  { name: 'Pending', color: '#f97316' },
];

const FALLBACK_COLOR = '#6b7280';
const DEFAULT_COLOR_BY_NAME = new Map(
  DEFAULT_TAGS.map((tag) => [tag.name.toLowerCase(), tag.color])
);

/** Green/blue/yellow/red/orange for the defaults, neutral grey for custom tags. */
export function defaultColorFor(name) {
  return DEFAULT_COLOR_BY_NAME.get(String(name ?? '').trim().toLowerCase()) ?? FALLBACK_COLOR;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tagsSchemaPath = path.join(here, '..', 'db', 'tags.schema.sql');

/**
 * Applies tags.schema.sql. Idempotent, and run on every boot so a database
 * created before Module 5 gets its tables without anyone remembering to
 * re-run `npm run migrate`.
 */
export async function ensureTagSchema() {
  const sql = await readFile(tagsSchemaPath, 'utf8');
  await query(sql);
}

export async function listTags() {
  const result = await query(
    `SELECT t.id, t.name, t.color, t.created_at, t.updated_at,
            (SELECT COUNT(*)::int FROM contact_tags ct WHERE ct.tag_id = t.id)
              AS assignment_count
       FROM tags t
      ORDER BY t.id`
  );
  return result.rows;
}

export async function getTagById(id) {
  const result = await query(
    'SELECT id, name, color, created_at, updated_at FROM tags WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/** Case-insensitive lookup, so "donation" matches "Donation". */
export async function findTagByName(name) {
  const result = await query(
    'SELECT id, name, color, created_at, updated_at FROM tags WHERE LOWER(name) = LOWER($1)',
    [String(name).trim()]
  );
  return result.rows[0] ?? null;
}

export async function createTag({ name, color }) {
  const result = await query(
    `INSERT INTO tags (name, color)
     VALUES ($1, $2)
     RETURNING id, name, color, created_at, updated_at`,
    [String(name).trim(), color ?? defaultColorFor(name)]
  );
  return result.rows[0] ?? null;
}

/**
 * Renames and/or recolours a tag. The partial UPDATE keeps an omitted field
 * untouched, and the LOWER(name) unique index turns a clash into a 23505 that
 * the error middleware answers with 409.
 */
export async function updateTag(id, { name, color }) {
  const result = await query(
    `UPDATE tags
        SET name = COALESCE($2, name),
            color = COALESCE($3, color),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, color, created_at, updated_at`,
    [id, name ? String(name).trim() : null, color ?? null]
  );
  return result.rows[0] ?? null;
}

/**
 * Deletes a tag. contact_tags cascades, so the label disappears from every
 * customer it was on while the customers and conversations stay exactly as
 * they were. Returns how many assignments were removed (for the confirmation
 * message the admin sees).
 */
export async function deleteTag(id) {
  const links = await query(
    'SELECT COUNT(*)::int AS total FROM contact_tags WHERE tag_id = $1',
    [id]
  );
  const deleted = await query('DELETE FROM tags WHERE id = $1 RETURNING id', [id]);
  if (deleted.rowCount === 0) return null;
  return { id, removedAssignments: links.rows[0].total };
}

/**
 * Finds the tag by name or creates it with its default colour. The
 * ON CONFLICT DO UPDATE is a no-op that only exists so the statement returns
 * the winning row under concurrency (two agents creating "VIP" at once both
 * end up with the same tag instead of one getting a unique violation).
 */
export async function resolveTagByName(name) {
  const trimmed = String(name ?? '').trim();
  const result = await query(
    `INSERT INTO tags (name, color)
     VALUES ($1, $2)
     ON CONFLICT (LOWER(name)) DO UPDATE SET updated_at = tags.updated_at
     RETURNING id, name, color`,
    [trimmed, defaultColorFor(trimmed)]
  );
  return result.rows[0] ?? null;
}

/** Tags currently on a contact, in seed order (defaults first). */
export async function getContactTags(contactId) {
  const result = await query(
    `SELECT t.id, t.name, t.color
       FROM contact_tags ctg
       JOIN tags t ON t.id = ctg.tag_id
      WHERE ctg.contact_id = $1
      ORDER BY t.id`,
    [contactId]
  );
  return result.rows;
}

/** Idempotent add: tagging a customer with a tag they already has is a no-op. */
export async function addContactTags(contactId, tagIds) {
  if (tagIds.length > 0) {
    await query(
      `INSERT INTO contact_tags (contact_id, tag_id)
       SELECT $1, link.tag_id
         FROM unnest($2::int[]) AS link(tag_id)
       ON CONFLICT DO NOTHING`,
      [contactId, tagIds]
    );
  }
  return getContactTags(contactId);
}

export async function removeContactTag(contactId, tagId) {
  await query('DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2', [
    contactId,
    tagId,
  ]);
  return getContactTags(contactId);
}

/**
 * Resolves free-text tag names (the Add Contact form) into real tag rows and
 * links them, creating a custom tag when the name is new. Used only on contact
 * creation, so the Module 1 contract (`tags: "New, VIP"`) keeps working while
 * the data ends up relational.
 */
export async function linkTagsByNames(contactId, names) {
  const resolved = [];
  for (const name of names) {
    const tag = await resolveTagByName(name);
    if (tag && !resolved.some((existing) => existing.id === tag.id)) resolved.push(tag);
  }
  if (resolved.length > 0) {
    await query(
      `INSERT INTO contact_tags (contact_id, tag_id)
       SELECT $1, link.tag_id
         FROM unnest($2::int[]) AS link(tag_id)
       ON CONFLICT DO NOTHING`,
      [contactId, resolved.map((tag) => tag.id)]
    );
  }
  return resolved;
}

/**
 * Safe, idempotent seed (§15):
 *   1. make sure the tables exist,
 *   2. insert the five defaults if they are missing (never duplicates),
 *   3. adopt whatever free-text tags older contacts already carry, so no
 *      existing data is lost when the array column is superseded.
 * Called at server start and by migrate/tests; running it twice changes
 * nothing.
 */
export async function seedTags() {
  await ensureTagSchema();

  for (const { name, color } of DEFAULT_TAGS) {
    await query(
      'INSERT INTO tags (name, color) VALUES ($1, $2) ON CONFLICT (LOWER(name)) DO NOTHING',
      [name, color]
    );
  }

  await migrateLegacyContactTags();
}

/**
 * Moves `contacts.tags` (Module 1 text array) into contact_tags. Reads only —
 * the array column itself is left untouched so nothing is deleted.
 */
async function migrateLegacyContactTags() {
  const legacy = await query(
    `SELECT c.id AS contact_id, btrim(tag) AS name
       FROM contacts c
       CROSS JOIN LATERAL unnest(c.tags) AS tag
      WHERE btrim(tag) <> ''`
  );
  if (legacy.rows.length === 0) return;

  const byName = new Map();
  for (const row of legacy.rows) {
    const key = row.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, row.name);
  }

  const resolved = new Map();
  for (const [key, name] of byName) {
    resolved.set(key, (await resolveTagByName(name)).id);
  }

  const contactIds = [];
  const tagIds = [];
  for (const row of legacy.rows) {
    contactIds.push(row.contact_id);
    tagIds.push(resolved.get(row.name.toLowerCase()));
  }

  await query(
    `INSERT INTO contact_tags (contact_id, tag_id)
     SELECT link.contact_id, link.tag_id
       FROM unnest($1::int[], $2::int[]) AS link(contact_id, tag_id)
     ON CONFLICT DO NOTHING`,
    [contactIds, tagIds]
  );
}
