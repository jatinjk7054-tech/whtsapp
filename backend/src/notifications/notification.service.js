import { query } from '../db/pool.js';
import { listDueRemindersForStaff } from '../reminders/reminder.repository.js';
import {
  countUnread,
  insertNotifications,
  listNotifications,
  markAllRead,
  markRead,
} from './notification.repository.js';

/**
 * Module 10 — notification generation and the feed read API.
 *
 * A notification is always scoped to a single staff member, and recipients are
 * chosen so that nobody is ever pointed at a conversation they may not open:
 * an assigned conversation notifies its owner, an unassigned one notifies the
 * admins (who are the only staff able to act on it).
 */

function titleForContact(conversation) {
  return conversation.contact_name?.trim() || conversation.contact_wa_id || 'Customer';
}

/** Assigned + active owner wins; otherwise every active admin. */
async function resolveMessageRecipients(conversation) {
  if (conversation.assigned_staff_id) {
    const owner = await query('SELECT id, is_active FROM staff WHERE id = $1', [conversation.assigned_staff_id]);
    if (owner.rows[0]?.is_active) return [owner.rows[0].id];
  }

  const admins = await query(
    "SELECT id FROM staff WHERE role = 'admin' AND is_active ORDER BY id"
  );
  return admins.rows.map((row) => row.id);
}

function previewFor(message) {
  if (message.body) return message.body.length > 140 ? `${message.body.slice(0, 137)}...` : message.body;
  return `[${message.type ?? 'message'}]`;
}

/**
 * Called for genuine inbound customer messages only (see inbound.service.js).
 * Creates one notification per eligible recipient, deduped on the local
 * message id so a Meta redelivery cannot double-notify.
 */
export async function notifyInboundMessage(conversation, message) {
  const recipients = await resolveMessageRecipients(conversation);
  if (recipients.length === 0) return 0;

  const title = titleForContact(conversation);
  const body = previewFor(message);

  return insertNotifications(
    recipients.map((staffId) => ({
      staffId,
      type: 'new_message',
      conversationId: conversation.id,
      reminderId: null,
      title,
      body,
      dedupeKey: `new_message:${message.id}`,
    }))
  );
}

/**
 * Notifies `staff` about any pending reminder that is due and still within
 * their scope, once. Runs on login/list so "due" alerts are produced by the
 * server clock, not a browser tab that may be closed.
 */
export async function sweepDueReminders(staff) {
  const due = await listDueRemindersForStaff(staff);
  if (due.length === 0) return 0;

  return insertNotifications(
    due.map((reminder) => ({
      staffId: staff.id,
      type: 'reminder_due',
      conversationId: reminder.conversation_id,
      reminderId: reminder.id,
      title: `Follow-up: ${reminder.contact_name?.trim() || reminder.contact_wa_id}`,
      body: reminder.title,
      dedupeKey: `reminder_due:${reminder.id}`,
    }))
  );
}

/** Sweeps due reminders first, then returns the newest notifications + unread. */
export async function listForStaff(staff, opts = {}) {
  await sweepDueReminders(staff);

  const [items, unread] = await Promise.all([
    listNotifications(staff.id, opts),
    countUnread(staff.id),
  ]);

  return { items, unread };
}

export async function markOneRead(staff, id) {
  await markRead(staff.id, id);
  return { id, read: true };
}

export async function markEverythingRead(staff) {
  const updated = await markAllRead(staff.id);
  return { updated };
}
