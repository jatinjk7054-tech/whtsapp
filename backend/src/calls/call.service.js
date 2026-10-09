import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/HttpError.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import {
  acceptCall,
  describeCallingError,
  getCallPermission,
  initiateCall,
  rejectCall,
  terminateCall,
} from '../lib/whatsapp/calling.js';
import { insertNotifications } from '../notifications/notification.repository.js';
import {
  getConversationById,
  getOrCreateOpenConversation,
} from '../conversations/conversation.repository.js';
import * as repo from './call.repository.js';

/**
 * Module 12 — WhatsApp Business Calling.
 *
 * The browser is the WebRTC endpoint; this service only relays SDP and owns the
 * call state machine. It never sees or stores audio. Authorisation mirrors the
 * rest of the inbox: an agent may only touch a conversation assigned to them,
 * an admin may touch any. Nothing here assigns a conversation.
 */

const isAdmin = (staff) => staff.role === 'admin';

const notFound = () => new HttpError(404, 'Call not found');
const notYours = () =>
  new HttpError(403, 'This conversation is assigned to another staff member');

function assertCanAccess(staff, conversation) {
  if (!isAdmin(staff) && conversation.assigned_staff_id !== staff.id) throw notYours();
}

function assertCallingConfigured() {
  if (!config.calling.configured) {
    throw new HttpError(503, 'WhatsApp calling is not enabled yet', {
      reason: 'calling_not_configured',
      checklist: getConfiguration().checklist,
    });
  }
}

/** Whether the requesting staff member should be handed the SDP for this call. */
function canSeeSignalling(staff, call) {
  if (call.initiatedByStaffId === staff.id) return true;
  if (call.answeredByStaffId === staff.id) return true;
  // Any authorised staff may answer a ringing inbound call, so the offer travels.
  return call.direction === 'inbound' && call.status === 'ringing';
}

function serialize(call, { staff = null } = {}) {
  const includeSdp = Boolean(staff) && canSeeSignalling(staff, call);
  return {
    id: call.id,
    conversationId: call.conversationId,
    direction: call.direction,
    status: call.status,
    contactWaId: call.contactWaId,
    contactName: call.contactName,
    initiatedByStaffId: call.initiatedByStaffId,
    answeredByStaffId: call.answeredByStaffId,
    initiatorName: call.initiatorName,
    answererName: call.answererName,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    endReason: call.endReason,
    errorCode: call.errorCode,
    errorDetail: call.errorDetail,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    ...(includeSdp ? { sdpOffer: call.sdpOffer, sdpAnswer: call.sdpAnswer } : {}),
  };
}

const CHECKLIST = [
  { id: 'whatsapp', label: 'WhatsApp Cloud API configured (phone number id + token)' },
  { id: 'calling_flag', label: 'Calling switched on for this backend (WHATSAPP_CALLING_ENABLED=true)' },
  { id: 'eligible_number', label: 'Business number eligible: messaging limit ≥ 2000 recipients/day' },
  { id: 'calling_enabled_meta', label: 'Calling enabled on the number in Meta (WhatsApp Manager → Calling)' },
  { id: 'webhook_field', label: 'App subscribed to the "calls" webhook field' },
  { id: 'call_permission', label: 'Customer has granted call permission (or calls you first)' },
  { id: 'https', label: 'App served over HTTPS (microphone / WebRTC need a secure context)' },
];

export function getConfiguration() {
  const done = {
    whatsapp: config.whatsapp.enabled,
    calling_flag: config.calling.enabled,
    eligible_number: null,
    calling_enabled_meta: null,
    webhook_field: null,
    call_permission: null,
    https: null,
  };

  return {
    enabled: config.calling.configured,
    whatsappConfigured: config.whatsapp.enabled,
    callingEnabled: config.calling.enabled,
    iceServers: config.calling.iceServers,
    checklist: CHECKLIST.map((item) => ({ ...item, done: done[item.id] })),
  };
}

async function loadConversationForCall(staff, call) {
  const conversation = await getConversationById(call.conversationId);
  if (!conversation) throw notFound();
  assertCanAccess(staff, conversation);
  return conversation;
}

async function loadAuthorisedCall(staff, callId) {
  const call = await repo.getCallById(callId);
  if (!call) throw notFound();
  const conversation = await loadConversationForCall(staff, call);
  return { call, conversation };
}

/**
 * Best-effort permission probe. A definitive "not granted" blocks the call with
 * an actionable message; an unavailable probe (older API, transient error) is
 * allowed through so Meta's own response decides.
 */
async function assertCallPermission(waId) {
  let permission;
  try {
    permission = await getCallPermission(waId);
  } catch (error) {
    console.error('[calling] permission check failed:', error.message);
    return;
  }

  if (permission.status && permission.status !== 'granted') {
    throw new HttpError(
      409,
      `Calling permission for this customer is "${permission.status}". Ask them to call you once, or use the business profile to request permission.`,
      { reason: 'call_permission_required', permissionStatus: permission.status }
    );
  }
}

/** Recipients for a system notification: the owner, else every active admin. */
async function resolveCallRecipients(conversation) {
  if (conversation.assigned_staff_id || conversation.assignedStaffId) {
    const ownerId = conversation.assigned_staff_id ?? conversation.assignedStaffId;
    const owner = await query('SELECT id, is_active FROM staff WHERE id = $1', [ownerId]);
    if (owner.rows[0]?.is_active) return [owner.rows[0].id];
  }
  const admins = await query("SELECT id FROM staff WHERE role = 'admin' AND is_active ORDER BY id");
  return admins.rows.map((row) => row.id);
}

async function notifyMissedCall(call) {
  const conversation = await getConversationById(call.conversationId);
  if (!conversation) return 0;

  const recipients = await resolveCallRecipients(conversation);
  if (recipients.length === 0) return 0;

  const title = conversation.contact_name?.trim() || conversation.contact_wa_id || 'Customer';
  const when = call.answeredAt ? 'ended' : 'missed';

  return insertNotifications(
    recipients.map((staffId) => ({
      staffId,
      type: 'missed_call',
      conversationId: call.conversationId,
      reminderId: null,
      title,
      body: call.direction === 'inbound' ? `Missed call (${when})` : 'Call not answered',
      dedupeKey: `missed_call:${call.id}`,
    }))
  );
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export async function listIncoming(staff) {
  const calls = await repo.listIncomingCallsForStaff(staff);
  // `staff` must be passed: serialize() only includes the SDP offer when it can
  // prove the requester may see it, and a ringing inbound call is exactly the
  // case the answering agent needs (without it the UI says "missing audio offer").
  return { items: calls.map((call) => serialize(call, { staff })) };
}

export async function listForConversation(staff, conversationId) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  assertCanAccess(staff, conversation);

  const calls = await repo.listCallsForConversation(conversationId);
  return {
    items: calls.map((call) => serialize(call, { staff })),
    // Surfaced so the UI can resume a call after a refresh instead of dropping it.
    activeCall: (() => {
      const active = calls.find((call) => repo.ACTIVE_CALL_STATUSES.includes(call.status));
      return active ? serialize(active, { staff }) : null;
    })(),
  };
}

export async function getCall(staff, callId) {
  const { call } = await loadAuthorisedCall(staff, callId);
  return serialize(call, { staff });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Places an outbound call. The browser has already produced an SDP offer; we
 * store it, push it to Meta, and return the row the UI polls for the answer.
 */
export async function startOutbound(staff, conversationId, { sdpOffer }) {
  assertCallingConfigured();

  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  assertCanAccess(staff, conversation);

  const existing = await repo.getActiveCallForConversation(conversationId);
  if (existing) {
    throw new HttpError(409, 'There is already an active call for this conversation', {
      callId: existing.id,
    });
  }

  const waId = conversation.contact_wa_id;
  await assertCallPermission(waId);

  const clientRef = randomUUID();
  let call = await repo.insertOutboundCall({
    conversationId,
    contactId: conversation.contact_id,
    clientRef,
    staffId: staff.id,
    sdpOffer,
  });

  try {
    const response = await initiateCall({ to: waId, sdpOffer, clientRef });
    const waCallId =
      response?.calls?.[0]?.id ?? response?.call_id ?? response?.id ?? null;
    call = (await repo.markOutboundCallSent(call.id, waCallId)) ?? call;
  } catch (error) {
    await repo.failCall(call.id, {
      code: error?.code ?? null,
      detail: error?.message ?? null,
      reason: 'initiate_failed',
    });
    throw new HttpError(502, describeCallingError(error), {
      reason: 'call_failed',
      code: error?.code ?? null,
    });
  }

  return serialize(call, { staff });
}

/** Answers an inbound ringing call with the browser's answer SDP. */
export async function answerInbound(staff, callId, { sdpAnswer }) {
  assertCallingConfigured();

  const { call } = await loadAuthorisedCall(staff, callId);

  if (call.direction !== 'inbound') {
    throw new HttpError(409, 'Only inbound calls can be answered');
  }
  if (call.status !== 'ringing') {
    throw new HttpError(409, `This call is no longer ringing (${call.status})`);
  }
  if (!call.waCallId) {
    throw new HttpError(409, 'This call has no provider id yet');
  }

  try {
    await acceptCall({ callId: call.waCallId, sdpAnswer, clientRef: call.clientRef });
  } catch (error) {
    await repo.failCall(call.id, {
      code: error?.code ?? null,
      detail: error?.message ?? null,
      reason: 'accept_failed',
    });
    throw new HttpError(502, describeCallingError(error), {
      reason: 'call_failed',
      code: error?.code ?? null,
    });
  }

  await repo.markCallAnsweredBy(call.id, staff.id);
  const updated = await repo.markCallConnecting(call.id);
  return serialize(updated ?? call, { staff });
}

/** Declines an inbound ringing call. */
export async function rejectInbound(staff, callId) {
  const { call } = await loadAuthorisedCall(staff, callId);

  if (repo.TERMINAL_CALL_STATUSES.includes(call.status)) {
    return serialize(call, { staff });
  }

  if (call.waCallId && config.whatsapp.enabled) {
    try {
      await rejectCall({ callId: call.waCallId, clientRef: call.clientRef });
    } catch (error) {
      // The customer may have hung up first; that is not an error for the agent.
      console.error('[calling] reject failed:', error.message);
    }
  }

  const updated = await repo.finalizeCall(call.id, {
    status: 'missed',
    endReason: 'rejected_by_staff',
  });
  return serialize(updated ?? call, { staff });
}

/** Hangs up (either direction). Idempotent for an already-finished call. */
export async function terminate(staff, callId) {
  const { call } = await loadAuthorisedCall(staff, callId);

  if (repo.TERMINAL_CALL_STATUSES.includes(call.status)) {
    return serialize(call, { staff });
  }

  if (call.waCallId && config.whatsapp.enabled) {
    try {
      await terminateCall({ callId: call.waCallId, clientRef: call.clientRef });
    } catch (error) {
      console.error('[calling] terminate failed:', error.message);
    }
  }

  const updated = await repo.finalizeCall(call.id, {
    status: call.answeredAt ? 'ended' : 'missed',
    endReason: 'staff_ended',
  });
  return serialize(updated ?? call, { staff });
}

// ---------------------------------------------------------------------------
// Webhook processing (called from conversations/inbound.service.js)
// ---------------------------------------------------------------------------

function callEventKey(raw, event) {
  return `${raw.waCallId ?? raw.clientRef}:${event}:${raw.timestamp ?? raw.status ?? ''}`;
}

async function handleConnect(raw, eventId) {
  if (raw.direction === 'inbound') {
    if (!raw.customerWaId) return;
    const conversation = await getOrCreateOpenConversation(raw.customerWaId, raw.profileName);
    const { call } = await repo.upsertInboundCall({
      waCallId: raw.waCallId,
      clientRef: raw.clientRef || raw.waCallId,
      conversationId: conversation.id,
      contactId: conversation.contact_id,
      sdpOffer: raw.sdp,
      startedAt: raw.timestamp,
    });
    await repo.attachCallEvent(eventId, call?.id);
    return;
  }

  // Business-initiated: attach Meta's answer SDP to the row we created.
  if (raw.clientRef) {
    const updated = await repo.setCallAnswerByClientRef(raw.clientRef, {
      waCallId: raw.waCallId,
      sdpAnswer: raw.sdp,
    });
    await repo.attachCallEvent(eventId, updated?.id);
  } else if (raw.waCallId) {
    const updated = await repo.setCallAnswerByWaCallId(raw.waCallId, raw.sdp);
    await repo.attachCallEvent(eventId, updated?.id);
  }
}

async function handleTerminate(raw, eventId) {
  const call = await repo.findCallForEvent(raw);
  if (!call) return;
  await repo.attachCallEvent(eventId, call.id);

  if (repo.TERMINAL_CALL_STATUSES.includes(call.status)) return;

  const answered = Boolean(call.answeredAt) || (raw.duration ?? 0) > 0;
  let status = 'missed';
  let endReason = 'no_answer';

  if (String(raw.status ?? '').toUpperCase() === 'FAILED') {
    status = answered ? 'ended' : 'failed';
    endReason = 'provider_failed';
  } else if (answered) {
    status = 'ended';
    endReason = 'completed';
  }

  const updated = await repo.finalizeCall(call.id, {
    status,
    endReason,
    durationSeconds: raw.duration ?? null,
    endedAt: raw.endTime ?? raw.timestamp ?? null,
    // A failed call keeps Meta's own code/message so the reason is visible in
    // the call history instead of a bare "failed".
    errorCode: status === 'failed' ? raw.errorCode ?? null : null,
    errorDetail: status === 'failed' ? raw.errorDetail ?? null : null,
  });

  if (updated && updated.status === 'missed') {
    try {
      await notifyMissedCall(updated);
    } catch (error) {
      console.error('Failed to notify missed call:', error.message);
    }
  }
}

/** Processes one `calls[]` event entry. Returns true when it changed state. */
export async function handleCallEvent(raw) {
  const event = String(raw.event ?? '').toLowerCase();

  // Recording/transcription notifications are recognised and deliberately
  // ignored: this feature never records or stores call audio.
  if (event !== 'connect' && event !== 'terminate') {
    await repo.recordCallEvent({
      dedupeKey: callEventKey(raw, event || 'ignored'),
      waCallId: raw.waCallId,
      clientRef: raw.clientRef,
      event: event || 'ignored',
      payload: { event: raw.event, status: raw.status },
    });
    return false;
  }

  const eventId = await repo.recordCallEvent({
    dedupeKey: callEventKey(raw, event),
    waCallId: raw.waCallId,
    clientRef: raw.clientRef,
    event,
    payload: {
      event: raw.event,
      direction: raw.direction,
      status: raw.status,
      duration: raw.duration,
    },
  });
  if (!eventId) return false; // duplicate redelivery

  if (event === 'connect') await handleConnect(raw, eventId);
  else await handleTerminate(raw, eventId);

  return true;
}

/** Processes one call status update (RINGING / ACCEPTED / REJECTED). */
export async function handleCallStatus(raw) {
  const status = String(raw.status ?? '').toUpperCase();
  if (!['RINGING', 'ACCEPTED', 'REJECTED'].includes(status)) return false;

  const eventId = await repo.recordCallEvent({
    dedupeKey: callEventKey(raw, `status:${status}`),
    waCallId: raw.waCallId,
    clientRef: raw.clientRef,
    event: `status:${status}`,
    payload: { status: raw.status },
  });
  if (!eventId) return false;

  const call = await repo.findCallForEvent(raw);
  if (!call) return false;
  await repo.attachCallEvent(eventId, call.id);

  if (status === 'ACCEPTED') {
    await repo.markCallConnected(call.id, { answeredAt: raw.timestamp });
  } else if (status === 'REJECTED') {
    const updated = await repo.finalizeCall(call.id, {
      status: 'missed',
      endReason: 'rejected_by_user',
    });
    if (updated && updated.direction === 'outbound') {
      try {
        await notifyMissedCall(updated);
      } catch (error) {
        console.error('Failed to notify rejected call:', error.message);
      }
    }
  }

  return true;
}

/** Boot safety net: never leave a phantom in-flight call behind. */
export async function sweepStaleCalls() {
  return repo.sweepStaleCalls();
}

export const constants = {
  ACTIVE_CALL_STATUSES: repo.ACTIVE_CALL_STATUSES,
  TERMINAL_CALL_STATUSES: repo.TERMINAL_CALL_STATUSES,
};
