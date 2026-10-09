import { config } from '../../config.js';
import { graphGet, graphPost } from './client.js';

/**
 * Module 12 — official WhatsApp Business Calling API signalling.
 *
 * Only the documented endpoints are used: `POST /{PHONE_NUMBER_ID}/calls` with
 * an action (connect/accept/reject/terminate), and the call-permission read.
 * No undocumented or unofficial signalling is attempted, and no audio is sent
 * to Meta — the browser is the media endpoint and only SDP passes through here.
 */

function callsPath() {
  return `/${config.whatsapp.phoneNumberId}/calls`;
}

/** Business-initiated call: we send our local SDP offer, Meta relays it. */
export async function initiateCall({ to, sdpOffer, clientRef }) {
  return graphPost(callsPath(), {
    messaging_product: 'whatsapp',
    to,
    action: 'connect',
    session: { sdp_type: 'offer', sdp: sdpOffer },
    // Echoed back on every event for this call, so it survives a Meta retry.
    biz_opaque_callback_data: clientRef,
  });
}

/**
 * Optional pre-accept. Kept for completeness/eligibility checks; the inbox
 * intentionally does NOT call it because no browser is attached when the Call
 * Connect webhook first arrives (the agent may not have answered yet).
 */
export async function preAcceptCall({ callId, sdpOffer, clientRef }) {
  return graphPost(callsPath(), {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: 'pre_accept',
    session: { sdp_type: 'offer', sdp: sdpOffer },
    ...(clientRef ? { biz_opaque_callback_data: clientRef } : {}),
  });
}

/** Agent answered an inbound call: send the browser's answer SDP. */
export async function acceptCall({ callId, sdpAnswer, clientRef }) {
  return graphPost(callsPath(), {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: 'accept',
    session: { sdp_type: 'answer', sdp: sdpAnswer },
    ...(clientRef ? { biz_opaque_callback_data: clientRef } : {}),
  });
}

/** Agent declined an inbound call. */
export async function rejectCall({ callId, clientRef }) {
  return graphPost(callsPath(), {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: 'reject',
    ...(clientRef ? { biz_opaque_callback_data: clientRef } : {}),
  });
}

/** Either side hung up. */
export async function terminateCall({ callId, clientRef }) {
  return graphPost(callsPath(), {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: 'terminate',
    ...(clientRef ? { biz_opaque_callback_data: clientRef } : {}),
  });
}

/**
 * Reads the call permission for one customer number. Shape is parsed
 * defensively because Meta's field naming differs across versions; callers treat
 * a thrown error as "unknown" and fall back to the live API's own error.
 */
export async function getCallPermission(waId) {
  const path = `/${config.whatsapp.phoneNumberId}/call_permissions?user_wa_id=${encodeURIComponent(waId)}`;
  const response = await graphGet(`https://graph.facebook.com/${config.whatsapp.graphVersion}${path}`);
  const payload = await response.json().catch(() => ({}));

  const entry = (payload?.data ?? [])[0] ?? payload;
  const status = entry?.permission?.status ?? entry?.status ?? null;
  const actions = (entry?.actions ?? []).map((a) => a?.action_name ?? a).filter(Boolean);

  return {
    status,
    actions,
    canStartCall: status === 'granted' && (actions.length === 0 || actions.includes('start_call')),
    expirationTime: entry?.permission?.expiration_time ?? null,
    raw: payload,
  };
}

/**
 * Enables/disables Calling on the business number. Admin-only convenience; the
 * inbox reports the resulting state from Meta rather than assuming success.
 */
export async function updateCallingSettings({ status, callIconVisibility, callbackPermissionStatus }) {
  return graphPost(`/${config.whatsapp.phoneNumberId}/settings`, {
    calling: {
      status,
      ...(callIconVisibility ? { call_icon_visibility: callIconVisibility } : {}),
      ...(callbackPermissionStatus ? { callback_permission_status: callbackPermissionStatus } : {}),
    },
  });
}

/** Meta error codes that map to a clear, actionable message in the inbox. */
export const CALLING_ERRORS = {
  138006: 'This customer has not granted call permission yet. Ask them to call you first, or use the business profile to request permission.',
  138009: 'The business phone number is not enabled for calling in Meta yet.',
  139000: 'Calling is not available for this account or region.',
};

export function describeCallingError(error) {
  if (!error) return 'Calling failed';
  if (error.code && CALLING_ERRORS[error.code]) return CALLING_ERRORS[error.code];
  return error.message || 'Calling failed';
}
