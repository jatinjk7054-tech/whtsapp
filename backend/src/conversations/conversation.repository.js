import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, query } from '../db/pool.js';

/**
 * Module 7 — the one canonical status vocabulary. Used by the API schemas, the
 * history table's CHECKs and the count defaults, so a fifth value can never be
 * half-supported.
 */
export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'];

const here = path.dirname(fileURLToPath(import.meta.url));
const statusSchemaPath = path.join(here, '..', 'db', 'status.schema.sql');

/**
 * Module 7 — widens conversations.status to allow 'resolved' and creates the
 * status history table. Idempotent and run at boot, so a database migrated
 * before Module 7 (or one created fresh by schema.sql) is correct either way.
 */
export async function ensureStatusSchema() {
  const sql = await readFile(statusSchemaPath, 'utf8');
  await query(sql);
}

/**
 * Appends one history row. `changedBy` is null for system moves (a new
 * customer message reopening a resolved thread).
 *
 * History is telemetry, not the status itself: if the table has not been
 * created yet the status change still goes through, because blocking a
 * customer's webhook on an audit row would be the wrong trade.
 */
let historyMissingWarned = false;

export async function recordStatusChange({ conversationId, oldStatus, newStatus, changedBy = null, client = null }) {
  if (!conversationId || !oldStatus || !newStatus || oldStatus === newStatus) return;

  const sql = `INSERT INTO conversation_status_history (conversation_id, old_status, new_status, changed_by)
               VALUES ($1, $2, $3, $4)`;
  const params = [conversationId, oldStatus, newStatus, changedBy];

  try {
    if (client) await client.query(sql, params);
    else await query(sql, params);
  } catch (error) {
    if (['42P01', '42703', '23503'].includes(error?.code) && !historyMissingWarned) {
      historyMissingWarned = true;
      console.error('Status history unavailable (run `npm run migrate`):', error.message);
    } else {
      console.error('Status history insert failed:', error.message);
    }
  }
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.status, c.last_message_at, c.last_message_preview,
         c.created_at, c.updated_at,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS last_inbound_at,
         ct.id AS contact_id, ct.wa_id AS contact_wa_id, ct.name AS contact_name,
         s.id AS assigned_staff_id, s.name AS assigned_staff_name,
         (SELECT COUNT(*)::int
            FROM messages m
           WHERE m.conversation_id = c.id
             AND m.direction = 'inbound'
             AND m.read_at IS NULL) AS unread_count,
         -- Module 5: the contact's tags, aggregated from the relationship
         -- table so nothing is ever duplicated onto the conversation row.
         COALESCE((
           SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.id)
             FROM contact_tags ctg
             JOIN tags t ON t.id = ctg.tag_id
            WHERE ctg.contact_id = ct.id
         ), '[]'::json) AS tags
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN staff s ON s.id = c.assigned_staff_id
`;

const SORTS = {
  recent: 'c.last_message_at DESC',
  oldest: 'c.last_message_at ASC',
  unread: 'c.last_message_at DESC',
};

export async function listConversations({
  assignedStaffId,
  status,
  search,
  tagIds,
  sort = 'recent',
  limit = 50,
  offset = 0,
  unreadOnly = false,
} = {}) {
  const conditions = [];
  const values = [];

  if (assignedStaffId !== undefined) {
    if (assignedStaffId === null) {
      conditions.push('c.assigned_staff_id IS NULL');
    } else {
      values.push(assignedStaffId);
      conditions.push(`c.assigned_staff_id = $${values.length}`);
    }
  }

  if (status) {
    values.push(status);
    conditions.push(`c.status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    let nameOrNumber = `(ct.name ILIKE $${values.length} OR ct.wa_id ILIKE $${values.length})`;
    // "+91 98193 45678" / "(91) 98193-45678" must still find the stored digits-only wa_id.
    const digits = search.replace(/\D/g, '');
    if (digits && digits !== search) {
      values.push(`%${digits}%`);
      nameOrNumber = `(${nameOrNumber} OR ct.wa_id ILIKE $${values.length})`;
    }
    conditions.push(nameOrNumber);
  }

  if (unreadOnly) {
    conditions.push(`EXISTS (
      SELECT 1 FROM messages um
       WHERE um.conversation_id = c.id
         AND um.direction = 'inbound'
         AND um.read_at IS NULL
    )`);
  }

  // Module 5: tag filter with ANY (OR) semantics — the conversation shows if
  // its customer carries at least one of the selected tags. It is a database
  // predicate, so the LIMIT/OFFSET page and the COUNT(*) total stay in step.
  if (tagIds?.length) {
    values.push(tagIds);
    conditions.push(`EXISTS (
      SELECT 1 FROM contact_tags ctf
       WHERE ctf.contact_id = ct.id
         AND ctf.tag_id = ANY($${values.length}::int[])
    )`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = SORTS[sort] ?? SORTS.recent;

  values.push(limit, offset);

  const result = await query(
    `${CONVERSATION_SELECT} ${where}
     ORDER BY ${orderBy}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
     ${where}`,
    values.slice(0, values.length - 2)
  );

  return { items: result.rows, total: countResult.rows[0].total };
}

export async function getConversationById(id) {
  const result = await query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Most recent thread for a WhatsApp address. Used to gate profile-picture access
 * with the same rules as getThread / the media proxy.
 */
export async function getConversationForContact(waId) {
  const result = await query(
    `SELECT c.id, c.status, c.assigned_staff_id
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.wa_id = $1
      ORDER BY c.updated_at DESC
      LIMIT 1`,
    [waId]
  );
  return result.rows[0] ?? null;
}

/**
 * Returns the live conversation for a WhatsApp address, creating or reopening
 * one as needed. Runs in a single transaction so two webhooks for the same
 * customer arriving at once cannot fork the thread — the partial unique index
 * `conversations_one_open_per_contact` is the final backstop, and a 23505 is
 * retried as a plain read.
 */
export async function getOrCreateOpenConversation(waId, profileName) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const contactResult = await client.query(
      `INSERT INTO contacts (wa_id, name)
       VALUES ($1, COALESCE($2, ''))
       ON CONFLICT (wa_id) DO UPDATE
         SET name = CASE
                      WHEN contacts.name = '' THEN EXCLUDED.name
                      ELSE contacts.name
                    END,
              updated_at = NOW()
       RETURNING id, wa_id, name`,
      [waId, profileName ?? '']
    );
    const contact = contactResult.rows[0];

    const live = await client.query(
      `SELECT id FROM conversations
       WHERE contact_id = $1 AND status <> 'closed'
       ORDER BY created_at DESC LIMIT 1`,
      [contact.id]
    );

    if (live.rows[0]) {
      const found = await client.query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [
        live.rows[0].id,
      ]);
      const conversation = found.rows[0];

      // Module 7 §8/§16 — a customer writing again means the thread is active.
      // The live thread (open, pending or resolved) is reopened in place: same
      // row, same owner, never a second conversation.
      if (conversation && conversation.status !== 'open') {
        await client.query(
          `UPDATE conversations SET status = 'open', updated_at = NOW() WHERE id = $1`,
          [conversation.id]
        );
        await recordStatusChange({
          client,
          conversationId: conversation.id,
          oldStatus: conversation.status,
          newStatus: 'open',
          changedBy: null,
        });
        conversation.status = 'open';
      }

      await client.query('COMMIT');
      return { ...conversation, isNewConversation: false };
    }

    // Customer wrote again after we closed the thread: reopen the most recent
    // one so history stays in a single place.
    const latest = await client.query(
      `SELECT id, status FROM conversations WHERE contact_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [contact.id]
    );

    const target = latest.rows[0];

    if (target) {
      const reopened = await client.query(
        `UPDATE conversations SET status = 'open', updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [target.id]
      );

      if (reopened.rowCount === 0) {
        await client.query('ROLLBACK');
        return getOrCreateOpenConversation(waId, profileName);
      }

      await recordStatusChange({
        client,
        conversationId: target.id,
        oldStatus: target.status,
        newStatus: 'open',
        changedBy: null,
      });

      const found = await client.query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [target.id]);
      await client.query('COMMIT');
      return { ...found.rows[0], isNewConversation: false };
    }

    const created = await client.query(
      `INSERT INTO conversations (contact_id) VALUES ($1) RETURNING id`,
      [contact.id]
    );

    const found = await client.query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [
      created.rows[0].id,
    ]);
    await client.query('COMMIT');
    return { ...found.rows[0], isNewConversation: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    // Lost the insert race against a concurrent webhook; the winner's row is
    // exactly what we wanted.
    if (error?.code === '23505') {
      return getOrCreateOpenConversation(waId, profileName);
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function claimConversation(id, staffId) {
  // Conditional UPDATE == compare-and-swap: two agents clicking "claim" at the
  // same instant both issue this, but only the first one matches the WHERE.
  const current = await query('SELECT status FROM conversations WHERE id = $1', [id]);
  const result = await query(
    `UPDATE conversations
        SET assigned_staff_id = $2,
            status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
            updated_at = NOW()
      WHERE id = $1
        AND (assigned_staff_id IS NULL OR assigned_staff_id = $2)
      RETURNING id`,
    [id, staffId]
  );

  if (result.rowCount === 0) return null;

  if (current.rows[0] && current.rows[0].status === 'closed') {
    await recordStatusChange({ conversationId: id, oldStatus: 'closed', newStatus: 'open', changedBy: staffId });
  }

  return getConversationById(id);
}

export async function assignConversation(id, staffId, changedBy = null) {
  const current = await query('SELECT status FROM conversations WHERE id = $1', [id]);
  const result = await query(
    `UPDATE conversations
        SET assigned_staff_id = $2::integer,
            status = CASE WHEN status = 'closed' AND $2::integer IS NOT NULL THEN 'open' ELSE status END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, staffId ?? null]
  );

  if (result.rowCount === 0) return null;

  const from = current.rows[0]?.status;
  if (from === 'closed' && staffId != null) {
    await recordStatusChange({ conversationId: id, oldStatus: from, newStatus: 'open', changedBy: changedBy ?? null });
  }

  return getConversationById(id);
}

export async function updateConversationStatus(id, status, changedBy = null) {
  const current = await query('SELECT status FROM conversations WHERE id = $1', [id]);
  const result = await query(
    `UPDATE conversations SET status = $2, updated_at = NOW()
     WHERE id = $1 RETURNING id`,
    [id, status]
  );

  if (result.rowCount === 0) return null;

  const from = current.rows[0]?.status;
  if (from !== status) {
    await recordStatusChange({ conversationId: id, oldStatus: from, newStatus: status, changedBy: changedBy ?? null });
  }

  return getConversationById(id);
}

/** Module 7 — newest-first trail of status transitions, grouped per thread. */
export async function listStatusHistory(conversationId, limit = 50) {
  const result = await query(
    `SELECT h.old_status, h.new_status, h.changed_at,
            s.name AS changed_by_name, s.id AS changed_by_id
       FROM conversation_status_history h
       LEFT JOIN staff s ON s.id = h.changed_by
      WHERE h.conversation_id = $1
      ORDER BY h.changed_at DESC
      LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows;
}

export async function touchConversation(id, preview) {
  await query(
    `UPDATE conversations
        SET last_message_at = NOW(),
            last_message_preview = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [id, (preview ?? '').slice(0, 160)]
  );
}

export async function countConversationsByStatus({ assignedStaffId } = {}) {
  const values = [];
  const where = [];

  if (assignedStaffId !== undefined) {
    if (assignedStaffId === null) {
      where.push('assigned_staff_id IS NULL');
    } else {
      values.push(assignedStaffId);
      where.push(`assigned_staff_id = $${values.length}`);
    }
  }

  const result = await query(
    `SELECT status, COUNT(*)::int AS total
       FROM conversations
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY status`,
    values
  );

  return Object.fromEntries(result.rows.map((row) => [row.status, row.total]));
}

/**
 * Returns the live conversation for a WhatsApp address, claiming it for the
 * given staff member only when it is brand new or still unassigned. An existing
 * owner is never transferred by a second agent — the conditional UPDATE is a
 * compare-and-swap, so two agents starting a chat with the same customer at the
 * same instant get exactly one winner and the loser is handed the owner's thread.
 */
export async function createOutboundConversation(waId, profileName, assignedStaffId) {
  const conversation = await getOrCreateOpenConversation(waId, profileName);
  if (assignedStaffId !== undefined && conversation.assigned_staff_id == null) {
    const result = await query(
      `UPDATE conversations
          SET assigned_staff_id = $2, updated_at = NOW()
        WHERE id = $1 AND assigned_staff_id IS NULL
        RETURNING id`,
      [conversation.id, assignedStaffId]
    );
    if (result.rowCount) return getConversationById(conversation.id);
  }
  return conversation;
}
