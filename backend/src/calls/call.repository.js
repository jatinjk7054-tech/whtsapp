import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 12 — persistence for WhatsApp voice calls.
 *
 * `call_events` is the idempotency gate (unique dedupe_key); `calls` keeps one
 * row per call. Neither table stores audio: only SDP signalling and metadata.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const callsSchemaPath = path.join(here, '..', 'db', 'calls.schema.sql');

/** Every status that means "the call is still in flight". */
export const ACTIVE_CALL_STATUSES = ['initiating', 'ringing', 'connecting', 'connected'];
/** Every status that means "the call is over". */
export const TERMINAL_CALL_STATUSES = ['ended', 'missed', 'failed'];

export async function ensureCallsSchema() {
  const sql = await readFile(callsSchemaPath, 'utf8');
  await query(sql);
}

export function normalizeCall(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    waCallId: row.wa_call_id,
    clientRef: row.client_ref,
    direction: row.direction,
    status: row.status,
    // Signalling is only handed to the caller by the service layer, and only
    // for the call's own participants. It is never part of list responses.
    sdpOffer: row.sdp_offer ?? null,
    sdpAnswer: row.sdp_answer ?? null,
    initiatedByStaffId: row.initiated_by_staff_id,
    answeredByStaffId: row.answered_by_staff_id,
    initiatorName: row.initiator_name ?? null,
    answererName: row.answerer_name ?? null,
    contactWaId: row.contact_wa_id ?? null,
    contactName: row.contact_name ?? null,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    endReason: row.end_reason,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CALL_SELECT = `
  SELECT c.*,
         ct.wa_id AS contact_wa_id, ct.name AS contact_name,
         ini.name AS initiator_name, ans.name AS answerer_name
    FROM calls c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN staff ini ON ini.id = c.initiated_by_staff_id
    LEFT JOIN staff ans ON ans.id = c.answered_by_staff_id
`;

/**
 * Creates the outbound call row before Meta is contacted, so a failure or a
 * crash still leaves an auditable record. `client_ref` is our correlation key.
 */
export async function insertOutboundCall({
  conversationId,
  contactId,
  clientRef,
  staffId,
  sdpOffer,
}) {
  const result = await query(
    `INSERT INTO calls
       (conversation_id, contact_id, client_ref, direction, status,
        sdp_offer, initiated_by_staff_id, started_at)
     VALUES ($1, $2, $3, 'outbound', 'initiating', $4, $5, NOW())
     RETURNING id`,
    [conversationId, contactId ?? null, clientRef, sdpOffer, staffId]
  );
  return getCallById(result.rows[0].id);
}

/** Records Meta's call id once the `connect` action has been accepted. */
export async function markOutboundCallSent(id, waCallId) {
  const result = await query(
    `UPDATE calls
        SET wa_call_id = COALESCE($2, wa_call_id),
            status = CASE WHEN status = 'initiating' THEN 'ringing' ELSE status END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, waCallId ?? null]
  );
  return result.rowCount > 0 ? getCallById(id) : null;
}

export async function failCall(id, { code = null, detail = null, reason = 'failed' } = {}) {
  const result = await query(
    `UPDATE calls
        SET status = 'failed',
            error_code = $2,
            error_detail = $3,
            end_reason = $4,
            ended_at = COALESCE(ended_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND status <> 'failed'
      RETURNING id`,
    [id, code, detail, reason]
  );
  return result.rowCount > 0 ? getCallById(id) : null;
}

/**
 * Inbound Call Connect webhook: create the call once, tolerate redelivery.
 * ON CONFLICT (wa_call_id) is the dedupe — a repeated connect is a no-op.
 */
export async function upsertInboundCall({
  waCallId,
  clientRef,
  conversationId,
  contactId,
  sdpOffer,
  startedAt = null,
}) {
  const inserted = await query(
    `INSERT INTO calls
       (conversation_id, contact_id, client_ref, wa_call_id, direction, status,
        sdp_offer, started_at)
     VALUES ($1, $2, $3, $4, 'inbound', 'ringing', $5, COALESCE($6, NOW()))
     ON CONFLICT (wa_call_id) DO NOTHING
     RETURNING id`,
    [conversationId, contactId ?? null, clientRef, waCallId, sdpOffer, startedAt]
  );

  if (inserted.rowCount > 0) return { call: await getCallById(inserted.rows[0].id), created: true };
  return { call: await getCallByWaCallId(waCallId), created: false };
}

/** Outbound Call Connect webhook: attach the answer SDP to our existing row. */
export async function setCallAnswerByClientRef(clientRef, { waCallId, sdpAnswer }) {
  const result = await query(
    `UPDATE calls
        SET wa_call_id = COALESCE($2, wa_call_id),
            sdp_answer = $3,
            status = CASE WHEN status IN ('initiating', 'ringing') THEN 'connecting' ELSE status END,
            updated_at = NOW()
      WHERE client_ref = $1
      RETURNING id`,
    [clientRef, waCallId ?? null, sdpAnswer ?? null]
  );
  return result.rowCount > 0 ? getCallById(result.rows[0].id) : null;
}

/** Fallback when a connect webhook carries no client_ref but has the wacid. */
export async function setCallAnswerByWaCallId(waCallId, sdpAnswer) {
  const result = await query(
    `UPDATE calls
        SET sdp_answer = $2,
            status = CASE WHEN status IN ('initiating', 'ringing') THEN 'connecting' ELSE status END,
            updated_at = NOW()
      WHERE wa_call_id = $1
      RETURNING id`,
    [waCallId, sdpAnswer ?? null]
  );
  return result.rowCount > 0 ? getCallById(result.rows[0].id) : null;
}

export async function getCallByClientRef(clientRef) {
  if (!clientRef) return null;
  const result = await query(`${CALL_SELECT} WHERE c.client_ref = $1`, [clientRef]);
  return normalizeCall(result.rows[0]);
}

/** Moves a call to 'connecting' (accept sent, awaiting connect confirmation). */
export async function markCallConnecting(id) {
  const result = await query(
    `UPDATE calls
        SET status = CASE WHEN status IN ('ringing', 'initiating') THEN 'connecting' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND status NOT IN ('ended', 'missed', 'failed')
      RETURNING id`,
    [id]
  );
  return result.rowCount > 0 ? getCallById(id) : null;
}

/** Resolves the local call for a webhook event by either correlation key. */
export async function findCallForEvent({ waCallId, clientRef }) {
  if (waCallId) {
    const byWaId = await getCallByWaCallId(waCallId);
    if (byWaId) return byWaId;
  }
  if (clientRef) return getCallByClientRef(clientRef);
  return null;
}

/** Marks a call connected (Meta ACCEPTED status, or a successful accept). */
export async function markCallConnected(id, { answeredAt = null } = {}) {
  const result = await query(
    `UPDATE calls
        SET status = 'connected',
            answered_at = COALESCE(answered_at, $2, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND status NOT IN ('ended', 'missed', 'failed')
      RETURNING id`,
    [id, answeredAt]
  );
  return result.rowCount > 0 ? getCallById(id) : null;
}

/** Assigns the answering agent when an inbound call is accepted. */
export async function markCallAnsweredBy(id, staffId) {
  await query(
    `UPDATE calls SET answered_by_staff_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, staffId]
  );
  return getCallById(id);
}

/**
 * Terminal transition. `durationSeconds` is Meta's own figure when it sent one,
 * otherwise the answer-to-end gap. Idempotent: a call already terminal is not
 * moved again by a later/duplicate terminate webhook.
 */
export async function finalizeCall(
  id,
  { status, endReason = null, durationSeconds = null, endedAt = null, errorCode = null, errorDetail = null } = {}
) {
  const target = TERMINAL_CALL_STATUSES.includes(status) ? status : 'ended';
  const result = await query(
    `UPDATE calls
        SET status = $2,
            end_reason = COALESCE($3, end_reason),
            ended_at = COALESCE(ended_at, $4, NOW()),
            duration_seconds = COALESCE(
              $5,
              duration_seconds,
              CASE WHEN answered_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(EPOCH FROM (COALESCE($4, NOW()) - answered_at))::int)
                   ELSE NULL END
            ),
            error_code = COALESCE($6, error_code),
            error_detail = COALESCE($7, error_detail),
            updated_at = NOW()
      WHERE id = $1 AND status NOT IN ('ended', 'missed', 'failed')
      RETURNING id`,
    [id, target, endReason, endedAt, durationSeconds, errorCode, errorDetail]
  );
  return result.rowCount > 0 ? getCallById(id) : null;
}

export async function getCallById(id) {
  const result = await query(`${CALL_SELECT} WHERE c.id = $1`, [id]);
  return normalizeCall(result.rows[0]);
}

export async function getCallByWaCallId(waCallId) {
  if (!waCallId) return null;
  const result = await query(`${CALL_SELECT} WHERE c.wa_call_id = $1`, [waCallId]);
  return normalizeCall(result.rows[0]);
}

/** Newest-first call history for one conversation, for the history panel. */
export async function listCallsForConversation(conversationId, limit = 50) {
  const result = await query(
    `${CALL_SELECT}
      WHERE c.conversation_id = $1
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $2`,
    [conversationId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return result.rows.map(normalizeCall);
}

/**
 * The one in-flight call for a conversation, if any. Used by the UI to resume
 * a call after a page refresh instead of silently dropping it.
 */
export async function getActiveCallForConversation(conversationId) {
  const result = await query(
    `${CALL_SELECT}
      WHERE c.conversation_id = $1
        AND c.status = ANY($2::text[])
      ORDER BY c.created_at DESC
      LIMIT 1`,
    [conversationId, ACTIVE_CALL_STATUSES]
  );
  return normalizeCall(result.rows[0]);
}

/**
 * Ringing inbound calls visible to a staff member. An agent only sees calls on
 * conversations assigned to them (the same rule as reading the inbox); an admin
 * sees every ringing call, including unassigned ones.
 */
export async function listIncomingCallsForStaff(staff, limit = 20) {
  const where = staff.role === 'admin' ? '' : 'AND conv.assigned_staff_id = $2';
  const params = staff.role === 'admin' ? [limit] : [limit, staff.id];
  const result = await query(
    `${CALL_SELECT}
       JOIN conversations conv ON conv.id = c.conversation_id
      WHERE c.direction = 'inbound'
        AND c.status = 'ringing'
        ${where}
      ORDER BY c.created_at DESC
      LIMIT $1`,
    params
  );
  return result.rows.map(normalizeCall);
}

/**
 * Records one Meta event; returns false when it is a duplicate. The unique
 * dedupe_key is the whole point: Meta redelivers webhooks until it sees a 200.
 */
export async function recordCallEvent({ dedupeKey, waCallId, clientRef, event, payload }) {
  const result = await query(
    `INSERT INTO call_events (dedupe_key, wa_call_id, client_ref, event, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [dedupeKey, waCallId ?? null, clientRef ?? null, event, payload ? JSON.stringify(payload) : null]
  );
  return result.rowCount > 0 ? Number(result.rows[0].id) : null;
}

export async function attachCallEvent(eventId, callId) {
  if (!eventId || !callId) return;
  await query('UPDATE call_events SET call_id = $2 WHERE id = $1', [eventId, callId]);
}

/**
 * Safety net: a call left non-terminal by a lost webhook (browser closed,
 * server restarted) is swept to 'missed'/'ended' rather than showing a phantom
 * "connected" forever. `ringingGraceSeconds` covers the answer window.
 */
export async function sweepStaleCalls({ ringingGraceSeconds = 120, connectedGraceSeconds = 7800 } = {}) {
  const ringing = await query(
    `UPDATE calls
        SET status = CASE WHEN direction = 'inbound' THEN 'missed' ELSE 'missed' END,
            end_reason = COALESCE(end_reason, 'no_answer'),
            ended_at = COALESCE(ended_at, NOW()),
            updated_at = NOW()
      WHERE status IN ('initiating', 'ringing', 'connecting')
        AND created_at < NOW() - ($1::int * INTERVAL '1 second')
        AND answered_at IS NULL
      RETURNING id`,
    [ringingGraceSeconds]
  );

  const connected = await query(
    `UPDATE calls
        SET status = 'ended',
            end_reason = COALESCE(end_reason, 'stale'),
            ended_at = COALESCE(ended_at, NOW()),
            duration_seconds = COALESCE(
              duration_seconds,
              GREATEST(0, EXTRACT(EPOCH FROM (NOW() - answered_at))::int)
            ),
            updated_at = NOW()
      WHERE status = 'connected'
        AND answered_at IS NOT NULL
        AND answered_at < NOW() - ($1::int * INTERVAL '1 second')
      RETURNING id`,
    [connectedGraceSeconds]
  );

  return { abandoned: ringing.rowCount, ended: connected.rowCount };
}
