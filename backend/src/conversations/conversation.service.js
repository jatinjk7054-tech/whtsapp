import { HttpError } from '../lib/HttpError.js';
import {
  assignConversation,
  claimConversation,
  CONVERSATION_STATUSES,
  countConversationsByStatus,
  getConversationById,
  createOutboundConversation,
  listConversations,
  listStatusHistory,
  updateConversationStatus,
} from './conversation.repository.js';
import { listMessages, markConversationRead, searchMessages } from './message.repository.js';
import { markMessageAsRead } from '../lib/whatsapp/client.js';

const isAdmin = (staff) => staff.role === 'admin';

const notFound = () => new HttpError(404, 'Conversation not found');
const notYours = () =>
  new HttpError(403, 'This conversation is assigned to another staff member');

/**
 * Best-effort: tell WhatsApp the customer\'s messages were read, so the
 * customer sees blue ticks. Runs ONLY when an agent actually opens a thread
 * with unread inbound messages (the frontend sends markRead=true only for that,
 * never for silent background polls). A Meta failure must never break the thread
 * response, so every error is swallowed and logged.
 */
function sendReadReceipts(waMessageIds) {
  for (const waMessageId of waMessageIds) {
    Promise.resolve()
      .then(() => markMessageAsRead(waMessageId))
      .catch((error) => {
        console.error(
          `Failed to send WhatsApp read receipt for ${waMessageId}:`,
          error.message
        );
      });
  }
}

function resolveScope(staff, { view, assignedStaffId }) {
  // Admins may inspect any single agent's queue via ?assignedStaffId=<id>.
  if (assignedStaffId !== undefined) {
    if (!isAdmin(staff)) throw new HttpError(403, 'Only admins can filter by assignee');
    return { assignedStaffId };
  }

  const requested = view ?? (isAdmin(staff) ? 'all' : 'mine');

  if (requested === 'mine') return { assignedStaffId: staff.id };
  if (requested === 'unassigned') return { assignedStaffId: null };
  if (requested === 'unread') {
    return isAdmin(staff) ? { unreadOnly: true } : { assignedStaffId: staff.id, unreadOnly: true };
  }
  if (requested === 'all') {
    if (!isAdmin(staff)) return { assignedStaffId: staff.id };
    return {};
  }

  return { assignedStaffId: staff.id };
}

/**
 * Module 5 — turns `?tags=2,4` into a clean id list. Anything that is not a
 * positive integer is dropped; an empty result means "no tag filter", so a
 * stray parameter can never hide every conversation by accident.
 */
const MAX_TAG_FILTER = 50;

function parseTagFilter(raw) {
  if (!raw) return undefined;
  const ids = [...new Set(String(raw).split(',').map((value) => Number(value.trim())))]
    .filter((value) => Number.isInteger(value) && value > 0)
    .slice(0, MAX_TAG_FILTER);
  return ids.length > 0 ? ids : undefined;
}

export async function listInbox(staff, filters) {
  const scope = resolveScope(staff, filters);

  const { items, total } = await listConversations({
    ...filters,
    assignedStaffId: scope.assignedStaffId,
    unreadOnly: scope.unreadOnly,
    // Tag filter (ANY) is applied inside the same query as status/search, so
    // the visibility scope, the existing filters and tags all combine.
    tagIds: parseTagFilter(filters.tags),
  });

  return {
    items,
    total,
    // Module 7 — counts for all four statuses, zero-filled so the UI always
    // shows a number. Admins see global counts; agents only their own queue.
    counts: {
      ...Object.fromEntries(CONVERSATION_STATUSES.map((status) => [status, 0])),
      ...(await countConversationsByStatus(
        isAdmin(staff) ? {} : { assignedStaffId: staff.id }
      )),
    },
  };
}

export async function getThread(staff, conversationId, { markRead = false, ...pagination } = {}) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw notFound();

  if (!isAdmin(staff) && conversation.assigned_staff_id !== staff.id) {
    throw notYours();
  }

  const messages = await listMessages(conversationId, { limit: 100, ...pagination });

  if (markRead && conversation.unread_count > 0) {
    const marked = await markConversationRead(conversationId, staff.id);
    conversation.unread_count = 0;
    // The agent has now genuinely read these; send WhatsApp the read receipt.
    if (marked.waMessageIds.length) sendReadReceipts(marked.waMessageIds);
  }

  return { conversation, messages };
}

export async function claim(staff, conversationId) {
  // Only admins can claim/reassign an unassigned conversation. Agents must
  // receive a conversation through an explicit admin assignment so one agent
  // can never take or inspect another agent's queue.
  if (!isAdmin(staff)) {
    throw new HttpError(403, 'Only admins can claim conversations');
  }

  const conversation = await claimConversation(conversationId, staff.id);

  if (!conversation) {
    const existing = await getConversationById(conversationId);
    if (!existing) throw notFound();
    throw new HttpError(409, 'Another staff member already claimed this conversation');
  }

  return conversation;
}

export async function assign(staff, conversationId, assigneeId) {
  if (!isAdmin(staff)) throw new HttpError(403, 'Only admins can assign conversations');

  const conversation = await assignConversation(conversationId, assigneeId, staff.id);
  if (!conversation) throw notFound();

  return conversation;
}

export async function unassign(staff, conversationId) {
  if (!isAdmin(staff)) throw new HttpError(403, 'Only admins can unassign conversations');

  const conversation = await assignConversation(conversationId, null, staff.id);
  if (!conversation) throw notFound();

  return conversation;
}

export async function setStatus(staff, conversationId, status) {
  const existing = await getConversationById(conversationId);
  if (!existing) throw notFound();

  if (!isAdmin(staff) && existing.assigned_staff_id !== staff.id) {
    throw notYours();
  }

  if (existing.status === status) return existing;

  return updateConversationStatus(conversationId, status, staff.id);
}

/**
 * Module 7 §26 — status history for one conversation. Same visibility rule as
 * every other conversation read: the owner may see their own, an admin any.
 */
export async function getStatusHistory(staff, conversationId) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw notFound();

  if (!isAdmin(staff) && conversation.assigned_staff_id !== staff.id) {
    throw notYours();
  }

  return { items: await listStatusHistory(conversationId) };
}

/**
 * Module 3 — message search. Uses the exact same visibility rules as the inbox
 * (resolveScope): an agent only ever searches their own conversations, an
 * admin searches everything.
 */
export async function searchMessagesForStaff(staff, { search, limit }) {
  const scope = resolveScope(staff, {});
  return searchMessages({
    scopeAssignedStaffId: scope.assignedStaffId,
    search,
    limit,
  });
}

export async function createConversationForOutbound(staff, waId, name) {
  const normalized = String(waId ?? '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(normalized)) {
    throw new HttpError(422, 'Enter a valid WhatsApp number with country code, for example 919876543210');
  }
  // Admins never need to self-assign; an agent claims the thread only if it is
  // new or unassigned. An existing owner is preserved, and the caller is told
  // about it below so a second agent cannot open another agent's customer.
  const assigned = isAdmin(staff) ? undefined : staff.id;
  const conversation = await createOutboundConversation(normalized, name?.trim() || '', assigned);

  if (!isAdmin(staff) && conversation.assigned_staff_id !== staff.id) {
    throw new HttpError(403, 'This customer is already assigned to another staff member');
  }

  return conversation;
}
