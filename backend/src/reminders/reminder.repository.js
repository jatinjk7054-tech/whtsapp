import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 10 — persistence for follow-up reminders.
 *
 * The visibility rule is deliberately identical to every other conversation
 * read in the product (see conversations/conversation.service.js):
 *   - an admin sees every reminder;
 *   - an agent sees a reminder only when they own its conversation, or when
 *     they created it while its conversation is (still) unassigned.
 *
 * That second clause is what stops a reminder from becoming a side door into
 * another agent's restricted conversation: once a conversation is assigned to
 * someone else, the previous creator loses sight of it here too.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const remindersSchemaPath = path.join(here, '..', 'db', 'reminders.schema.sql');

/** Applies reminders.schema.sql. Idempotent — safe on every boot. */
export async function ensureRemindersSchema() {
  const sql = await readFile(remindersSchemaPath, 'utf8');
  await query(sql);
}

export const REMINDER_STATUSES = ['pending', 'completed', 'cancelled'];

const REMINDER_SELECT = `
  SELECT r.id, r.conversation_id, r.title, r.notes, r.due_at, r.status,
         r.created_by, r.completed_at, r.created_at, r.updated_at,
         (r.status = 'pending' AND r.due_at < NOW()) AS is_overdue,
         c.status AS conversation_status,
         ct.id AS contact_id, ct.wa_id AS contact_wa_id, ct.name AS contact_name,
         s.name AS created_by_name
    FROM reminders r
    JOIN conversations c ON c.id = r.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN staff s ON s.id = r.created_by
`;

export function normalizeReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOverdue: Boolean(row.is_overdue),
    conversation: {
      id: row.conversation_id,
      status: row.conversation_status,
      contactId: row.contact_id,
      contactWaId: row.contact_wa_id,
      contactName: row.contact_name,
    },
  };
}

/* --------------------------------------------------------------- clauses -- */

function scopeClause(staff, values) {
  if (staff.role === 'admin') return null;
  values.push(staff.id);
  const me = `$${values.length}`;
  return `(c.assigned_staff_id = ${me} OR (r.created_by = ${me} AND c.assigned_staff_id IS NULL))`;
}

function searchClause(search, values) {
  if (!search) return null;
  values.push(`%${search}%`);
  let clause = `(ct.name ILIKE $${values.length} OR ct.wa_id ILIKE $${values.length})`;
  const digits = search.replace(/\D/g, '');
  if (digits && digits !== search) {
    values.push(`%${digits}%`);
    clause = `(${clause} OR ct.wa_id ILIKE $${values.length})`;
  }
  return clause;
}

/** Pushes the timezone once and returns a `$n` placeholder that reuses it. */
function tzRef(values, timezone) {
  values.push(timezone);
  return `$${values.length}`;
}

function filterClause(filter, values, timezone) {
  // `due_today` and `upcoming` are calendar comparisons in the caller's zone;
  // `overdue` is a plain "due in the past" test that needs no timezone.
  switch (filter) {
    case 'overdue':
      return `(r.status = 'pending' AND r.due_at < NOW())`;
    case 'due_today': {
      const tz = tzRef(values, timezone);
      return `(r.status = 'pending'
        AND (r.due_at AT TIME ZONE ${tz})::date = (NOW() AT TIME ZONE ${tz})::date)`;
    }
    case 'upcoming': {
      const tz = tzRef(values, timezone);
      return `(r.status = 'pending'
        AND r.due_at >= NOW()
        AND (r.due_at AT TIME ZONE ${tz})::date > (NOW() AT TIME ZONE ${tz})::date)`;
    }
    case 'completed':
      return `(r.status = 'completed')`;
    case 'cancelled':
      return `(r.status = 'cancelled')`;
    case 'pending':
      return `(r.status = 'pending')`;
    case 'all':
    default:
      return null;
  }
}

const ORDER_BY = {
  overdue: 'r.due_at ASC, r.id ASC',
  due_today: 'r.due_at ASC, r.id ASC',
  upcoming: 'r.due_at ASC, r.id ASC',
  completed: 'r.completed_at DESC NULLS LAST, r.id DESC',
  cancelled: 'r.updated_at DESC, r.id DESC',
  pending: 'r.due_at ASC, r.id ASC',
  all: `CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.due_at ASC, r.id DESC`,
};

function baseConditions(staff, { search }, values) {
  const conditions = [];
  const scope = scopeClause(staff, values);
  if (scope) conditions.push(scope);
  const searchSql = searchClause(search, values);
  if (searchSql) conditions.push(searchSql);
  return conditions;
}

/* ------------------------------------------------------------------ list -- */

export async function listReminders(staff, {
  filter = 'all',
  search,
  conversationId,
  timezone = 'Asia/Kolkata',
  limit = 50,
  offset = 0,
} = {}) {
  const values = [];
  const conditions = baseConditions(staff, { search }, values);

  if (conversationId) {
    values.push(conversationId);
    conditions.push(`r.conversation_id = $${values.length}`);
  }

  const filterSql = filterClause(filter, values, timezone);
  if (filterSql) conditions.push(filterSql);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = ORDER_BY[filter] ?? ORDER_BY.all;

  values.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const limitIdx = values.length;
  values.push(Math.max(Number(offset) || 0, 0));
  const offsetIdx = values.length;

  const items = await query(
    `${REMINDER_SELECT} ${where}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  // Status counts are computed over the same scope + search, ignoring the
  // active status filter, so the dashboard tabs always show stable numbers.
  const countValues = [];
  const countConditions = baseConditions(staff, { search }, countValues);
  if (conversationId) {
    countValues.push(conversationId);
    countConditions.push(`r.conversation_id = $${countValues.length}`);
  }
  const tz = tzRef(countValues, timezone);
  const countWhere = countConditions.length ? `WHERE ${countConditions.join(' AND ')}` : '';

  const counts = await query(
    `SELECT
        COUNT(*)::int AS all_count,
        COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE r.status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled_count,
        COUNT(*) FILTER (WHERE r.status = 'pending' AND r.due_at < NOW())::int AS overdue_count,
        COUNT(*) FILTER (WHERE r.status = 'pending'
          AND (r.due_at AT TIME ZONE ${tz})::date = (NOW() AT TIME ZONE ${tz})::date)::int AS due_today_count,
        COUNT(*) FILTER (WHERE r.status = 'pending'
          AND r.due_at >= NOW()
          AND (r.due_at AT TIME ZONE ${tz})::date > (NOW() AT TIME ZONE ${tz})::date)::int AS upcoming_count
       FROM reminders r
       JOIN conversations c ON c.id = r.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
      ${countWhere}`,
    countValues
  );

  const row = counts.rows[0] ?? {};
  return {
    items: items.rows.map(normalizeReminder),
    total: row.all_count ?? 0,
    counts: {
      all: row.all_count ?? 0,
      pending: row.pending_count ?? 0,
      completed: row.completed_count ?? 0,
      cancelled: row.cancelled_count ?? 0,
      overdue: row.overdue_count ?? 0,
      dueToday: row.due_today_count ?? 0,
      upcoming: row.upcoming_count ?? 0,
    },
  };
}

export async function getReminderById(id) {
  const result = await query(`${REMINDER_SELECT} WHERE r.id = $1`, [id]);
  return normalizeReminder(result.rows[0]);
}

/** Raw row (with conversation ownership) used for permission checks. */
export async function getReminderRow(id) {
  const result = await query(
    `SELECT r.id, r.conversation_id, r.status, r.created_by, r.due_at,
            c.assigned_staff_id
       FROM reminders r
       JOIN conversations c ON c.id = r.conversation_id
      WHERE r.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function createReminder({ conversationId, title, notes = '', dueAt, createdBy = null }) {
  const result = await query(
    `INSERT INTO reminders (conversation_id, title, notes, due_at, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [conversationId, title, notes, dueAt, createdBy]
  );
  return getReminderById(result.rows[0].id);
}

export async function updateReminder(id, { title, notes, dueAt }) {
  const fields = [];
  const values = [id];

  if (title !== undefined) {
    values.push(title);
    fields.push(`title = $${values.length}`);
  }
  if (notes !== undefined) {
    values.push(notes);
    fields.push(`notes = $${values.length}`);
  }
  if (dueAt !== undefined) {
    values.push(dueAt);
    fields.push(`due_at = $${values.length}`);
  }

  if (fields.length === 0) return getReminderById(id);

  values.push(new Date());
  fields.push(`updated_at = $${values.length}`);

  const result = await query(
    `UPDATE reminders SET ${fields.join(', ')}
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    values
  );
  if (result.rowCount === 0) return null;
  return getReminderById(id);
}

/**
 * Moves a reminder between statuses. Completing stamps `completed_at` (and
 * reopening clears it), so the dashboard can order by when it was finished.
 */
export async function setReminderStatus(id, status) {
  const result = await query(
    `UPDATE reminders
        SET status = $2,
            completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, status]
  );
  if (result.rowCount === 0) return null;
  return getReminderById(id);
}

/**
 * Pending reminders that are due (or overdue) and still visible to `staff`,
 * paired with whether the staff member has already been told. Used by the
 * due-reminder sweep; the JOIN keeps the query bounded to interesting rows.
 */
export async function listDueRemindersForStaff(staff) {
  const values = [];
  const conditions = [`r.status = 'pending' AND r.due_at <= NOW()`];

  const scope = scopeClause(staff, values);
  if (scope) conditions.push(scope);

  const result = await query(
    `SELECT r.id, r.conversation_id, r.title, r.due_at,
            ct.name AS contact_name, ct.wa_id AS contact_wa_id
       FROM reminders r
       JOIN conversations c ON c.id = r.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.due_at ASC
      LIMIT 500`,
    values
  );
  return result.rows;
}
