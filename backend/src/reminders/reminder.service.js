import { HttpError } from '../lib/HttpError.js';
import { getConversationById } from '../conversations/conversation.repository.js';
import { getAnalyticsTimezone } from '../analytics/agent-performance.repository.js';
import {
  createReminder,
  getReminderById,
  getReminderRow,
  listReminders,
  setReminderStatus,
  updateReminder,
} from './reminder.repository.js';

/**
 * Module 10 — follow-up reminder business rules, including the permission
 * checks. As with every conversation endpoint, the backend is the gate:
 * agents may only set reminders on conversations assigned to them, and may
 * only read reminders their scope covers.
 */

const isAdmin = (staff) => staff.role === 'admin';

const notFound = () => new HttpError(404, 'Reminder not found');
const notYours = () =>
  new HttpError(403, 'This conversation is assigned to another staff member');

/**
 * Reminders set for today or earlier are legitimate (the clock may have run
 * past a reminder created a moment ago), but a clearly-past date is almost
 * always a mistake, so it is rejected.
 */
const PAST_TOLERANCE_MS = 5 * 60 * 1000;

function assertDueDate(dueAt) {
  if (Number.isNaN(dueAt.getTime())) {
    throw new HttpError(422, 'A valid due date and time is required');
  }
  if (dueAt.getTime() < Date.now() - PAST_TOLERANCE_MS) {
    throw new HttpError(422, 'The due date cannot be in the past');
  }
}

async function resolveTimezone(timezone) {
  return timezone ?? (await getAnalyticsTimezone());
}

/** Admin: any conversation. Agent: only a conversation they own. */
async function assertCanCreate(staff, conversationId) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found');

  if (!isAdmin(staff) && conversation.assigned_staff_id !== staff.id) {
    throw notYours();
  }
  return conversation;
}

/** Same visibility as the reminder list/repository scope. */
function canSeeRow(staff, row) {
  if (isAdmin(staff)) return true;
  return (
    row.assigned_staff_id === staff.id ||
    (row.created_by === staff.id && row.assigned_staff_id === null)
  );
}

export async function list(staff, filters) {
  const timezone = await resolveTimezone(filters.timezone);
  return listReminders(staff, { ...filters, timezone });
}

export async function get(staff, id) {
  const row = await getReminderRow(id);
  if (!row || !canSeeRow(staff, row)) throw notFound();
  return getReminderById(id);
}

export async function create(staff, input) {
  await assertCanCreate(staff, input.conversationId);
  assertDueDate(input.dueAt);

  return createReminder({
    conversationId: input.conversationId,
    title: input.title,
    notes: input.notes ?? '',
    dueAt: input.dueAt,
    createdBy: staff.id,
  });
}

export async function update(staff, id, patch) {
  const row = await getReminderRow(id);
  if (!row || !canSeeRow(staff, row)) throw notFound();
  if (row.status !== 'pending') {
    throw new HttpError(409, 'Only pending reminders can be edited');
  }
  if (patch.dueAt !== undefined) assertDueDate(patch.dueAt);

  const updated = await updateReminder(id, patch);
  if (!updated) throw new HttpError(409, 'Only pending reminders can be edited');
  return updated;
}

const STATUS_ACTIONS = {
  complete: 'completed',
  cancel: 'cancelled',
  reopen: 'pending',
};

export async function changeStatus(staff, id, action) {
  const nextStatus = STATUS_ACTIONS[action];
  if (!nextStatus) throw new HttpError(422, 'Unknown reminder action');

  const row = await getReminderRow(id);
  if (!row || !canSeeRow(staff, row)) throw notFound();

  if (row.status === nextStatus) return getReminderById(id);

  return setReminderStatus(id, nextStatus);
}
