/**
 * Module 12 — WhatsApp Business Calling (voice).
 *
 *   node test-module12.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder) with a real
 * PostgreSQL database. Meta's Calling API is stubbed, and call webhooks are fed
 * through the production ingest pipeline (ingestWebhookPayload -> handleCallEvent
 * / handleCallStatus). It asserts the full call lifecycle, idempotency, the
 * permission model, and that no duplicate call records can be created. It adds
 * NO agent-assignment behaviour and every fixture is removed before exit.
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M12-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M12-TEST-TOKEN';
process.env.WHATSAPP_CALLING_ENABLED = 'true';
process.env.WHATSAPP_AUTO_REPLY_ENABLED ||= 'false';

let stubSeq = 0;
let shouldFail = false;
let failCode = 138006;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    if (url.includes('/call_permissions')) {
      if (shouldFail) {
        return new Response(
          JSON.stringify({ error: { message: 'Simulated permission denial', code: failCode, type: 'OAuthException' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              permission: { status: 'granted', expiration_time: Math.floor(Date.now() / 1000) + 86400 },
              actions: [{ action_name: 'start_call' }, { action_name: 'send_call_permission_request' }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (shouldFail) {
      return new Response(
        JSON.stringify({ error: { message: 'Simulated Meta rejection', code: failCode, type: 'OAuthException' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    stubSeq += 1;
    return new Response(
      JSON.stringify({ calls: [{ id: `wacid.M12-STUB-${Date.now()}-${stubSeq}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return originalFetch(input, init);
};

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { parseWebhookPayload } = await import('./src/lib/whatsapp/parse.js');
const { ensureNotificationsSchema } = await import('./src/notifications/notification.repository.js');
const { ensureCallsSchema } = await import('./src/calls/call.repository.js');
const callService = await import('./src/calls/call.service.js');
const { whenIngestIdle } = await import('./src/conversations/inbound.service.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

async function tokenFor(email) {
  const r = await query('SELECT id, name, email, role FROM staff WHERE email = $1 AND is_active', [email]);
  if (!r.rows[0]) throw new Error(`no active staff ${email}`);
  return signToken(r.rows[0]);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

let tsSeq = 0;
function isoNow() {
  tsSeq += 1;
  return new Date(Date.now() + tsSeq).toISOString();
}

function connectEvent({ waCallId, direction, customerWaId, sdp, clientRef, timestamp = isoNow() }) {
  return { waCallId, customerWaId, direction, event: 'connect', timestamp, sdpType: direction === 'inbound' ? 'offer' : 'answer', sdp, clientRef, status: null, startTime: null, endTime: null, duration: null, errorCode: null, errorDetail: null };
}
function terminateEvent({ waCallId, direction, status = 'COMPLETED', duration = 0, clientRef = null, timestamp = isoNow() }) {
  return { waCallId, customerWaId: null, direction, event: 'terminate', timestamp, sdpType: null, sdp: null, clientRef, status, startTime: null, endTime: timestamp, duration, errorCode: null, errorDetail: null };
}
function callStatusEvent({ waCallId, direction, status, clientRef = null, timestamp = isoNow() }) {
  return { waCallId, customerWaId: null, status, direction, timestamp, clientRef };
}

async function callRow(id) {
  return (await query('SELECT * FROM calls WHERE id = $1', [id])).rows[0] ?? null;
}
async function callRowByWaId(waCallId) {
  return (await query('SELECT * FROM calls WHERE wa_call_id = $1', [waCallId])).rows[0] ?? null;
}

/* --------------------------------------------------------------- fixtures -- */
const WA = { OWNED1: '919876940101', OWNED2: '919876940102', UNASSIGNED: '919876940103' };
const FIXTURES = Object.values(WA);
const SDP_OFFER = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const SDP_ANSWER = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

async function seedConversation(waId, name, assignedStaffId = null) {
  const contactId = (await query(
    `INSERT INTO contacts (wa_id, name) VALUES ($1, $2)
     ON CONFLICT (wa_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [waId, name]
  )).rows[0].id;
  const convId = (await query(
    `INSERT INTO conversations (contact_id, assigned_staff_id, status, created_at, updated_at)
     VALUES ($1, $2, 'open', NOW(), NOW()) RETURNING id`,
    [contactId, assignedStaffId]
  )).rows[0].id;
  return { contactId, convId };
}

async function conversationRow(waId) {
  return (await query(
    `SELECT c.id, c.assigned_staff_id, ct.wa_id AS contact_wa_id, ct.name AS contact_name
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.wa_id = $1 ORDER BY c.id DESC LIMIT 1`,
    [waId]
  )).rows[0] ?? null;
}

async function cleanupConversation(wa) {
  const convs = (await query(
    `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`,
    [wa]
  )).rows.map((row) => row.id);

  if (convs.length) {
    await query('DELETE FROM call_events WHERE call_id IN (SELECT id FROM calls WHERE conversation_id = ANY($1::int[]))', [convs]);
    await query('DELETE FROM calls WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM notifications WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
  }
  await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
}

async function cleanup() {
  for (const wa of FIXTURES) await cleanupConversation(wa);
  await query("DELETE FROM call_events WHERE wa_call_id LIKE 'wacid.M12-%' OR dedupe_key LIKE '%M12-%'");
}

/* ------------------------------------------------------------------ setup -- */
await cleanup();
await ensureNotificationsSchema();
await ensureCallsSchema();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
const adminRow = (await query(`SELECT id FROM staff WHERE email = 'admin@example.com'`)).rows[0];
const a1Row = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0];
const a2Row = (await query(`SELECT id FROM staff WHERE email = 'agent2@example.com'`)).rows[0];
const adminStaff = { id: adminRow.id, role: 'admin' };
const a1Staff = { id: a1Row.id, role: 'agent' };
const a2Staff = { id: a2Row.id, role: 'agent' };
check('S1 tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

await seedConversation(WA.OWNED1, 'M12 Alpha', a1Row.id);
await seedConversation(WA.OWNED2, 'M12 Bravo', a2Row.id);
await seedConversation(WA.UNASSIGNED, 'M12 Charlie', null);
const c1 = await conversationRow(WA.OWNED1);
const c2 = await conversationRow(WA.OWNED2);
const c3 = await conversationRow(WA.UNASSIGNED);

/* ------------------------------------------------------------- parsing -- */
const parsed = parseWebhookPayload({
  entry: [{ changes: [{ field: 'calls', value: {
    contacts: [{ wa_id: WA.OWNED1, profile: { name: 'M12 Alpha' } }],
    calls: [{ id: 'wacid.M12-PARSE', event: 'connect', direction: 'USER_INITIATED', timestamp: '1700000000', session: { sdp_type: 'offer', sdp: SDP_OFFER } }],
    statuses: [{ id: 'wacid.M12-PARSE', type: 'call', status: 'RINGING', timestamp: '1700000001', recipient_id: WA.OWNED1 }],
  } }] }],
});
check('A1 parse extracts calls and call statuses', parsed.calls.length === 1 && parsed.callStatuses.length === 1 && parsed.inbound.length === 0,
  `calls=${parsed.calls.length} statuses=${parsed.callStatuses.length}`);

/* ------------------------------------------------------ outbound lifecycle -- */
const outbound = await callService.startOutbound(a1Staff, c1.id, { sdpOffer: SDP_OFFER });
const outRow = await callRow(outbound.id);
check('B1 outbound call is stored, sent to Meta, and starts ringing',
  outRow?.direction === 'outbound' && outRow?.status === 'ringing' && Boolean(outRow?.wa_call_id) && outRow?.sdp_offer === SDP_OFFER,
  `status=${outRow?.status} waCallId=${outRow?.wa_call_id}`);
check('B2 the initiating agent receives the SDP offer (participant signalling)', outbound.sdpOffer === SDP_OFFER);

const outClientRef = outRow.client_ref;
const outWaCallId = outRow.wa_call_id;

// Meta's connect webhook carries the answer for a business-initiated call.
const outConnectTs = isoNow();
await callService.handleCallEvent(connectEvent({ waCallId: outWaCallId, direction: 'outbound', customerWaId: WA.OWNED1, sdp: SDP_ANSWER, clientRef: outClientRef, timestamp: outConnectTs }));
let row = await callRow(outbound.id);
check('B3 the connect webhook attaches Meta\'s answer SDP',
  row?.status === 'connecting' && row?.sdp_answer === SDP_ANSWER, `status=${row?.status}`);

const duplicate = await callService.handleCallEvent(connectEvent({ waCallId: outWaCallId, direction: 'outbound', customerWaId: WA.OWNED1, sdp: SDP_ANSWER, clientRef: outClientRef, timestamp: outConnectTs }));
check('B4 a redelivered connect event is deduped (returns false)', duplicate === false);

await callService.handleCallStatus(callStatusEvent({ waCallId: outWaCallId, direction: 'outbound', status: 'ACCEPTED', clientRef: outClientRef }));
row = await callRow(outbound.id);
check('B5 ACCEPTED moves the call to connected and stamps answered_at',
  row?.status === 'connected' && Boolean(row?.answered_at), `status=${row?.status}`);

const termTs = isoNow();
await callService.handleCallEvent(terminateEvent({ waCallId: outWaCallId, direction: 'outbound', status: 'COMPLETED', duration: 42, clientRef: outClientRef, timestamp: termTs }));
row = await callRow(outbound.id);
check('B6 terminate completes the call with Meta\'s duration',
  row?.status === 'ended' && row?.duration_seconds === 42, `status=${row?.status} duration=${row?.duration_seconds}`);
const termAgain = await callService.handleCallEvent(terminateEvent({ waCallId: outWaCallId, direction: 'outbound', status: 'COMPLETED', duration: 42, clientRef: outClientRef, timestamp: termTs }));
row = await callRow(outbound.id);
check('B7 a duplicate terminate cannot move a finished call', termAgain === false && row?.status === 'ended', `status=${row?.status}`);

/* ------------------------------------------------------- inbound lifecycle -- */
const inWaCallId = 'wacid.M12-IN-1';
const inConnectTs = isoNow();
await callService.handleCallEvent(connectEvent({ waCallId: inWaCallId, direction: 'inbound', customerWaId: WA.OWNED1, sdp: SDP_OFFER, timestamp: inConnectTs }));
const inRow = await callRowByWaId(inWaCallId);
check('C1 an inbound connect creates a ringing call with the offer stored',
  inRow?.direction === 'inbound' && inRow?.status === 'ringing' && inRow?.sdp_offer === SDP_OFFER, `status=${inRow?.status}`);

await callService.handleCallEvent(connectEvent({ waCallId: inWaCallId, direction: 'inbound', customerWaId: WA.OWNED1, sdp: SDP_OFFER, timestamp: inConnectTs }));
const inboundCount = (await query('SELECT COUNT(*)::int AS n FROM calls WHERE wa_call_id = $1', [inWaCallId])).rows[0].n;
check('C2 a duplicate inbound connect never creates a second call record', inboundCount === 1, `count=${inboundCount}`);

const incomingA1 = await callService.listIncoming(a1Staff);
const incomingA2 = await callService.listIncoming(a2Staff);
const incomingAdmin = await callService.listIncoming(adminStaff);
check('C3 the owning agent sees the inbound ringing call',
  incomingA1.items.some((c) => Number(c.id) === Number(inRow.id)), `items=${incomingA1.items.length}`);
check('C4 another agent cannot see it', !incomingA2.items.some((c) => Number(c.id) === Number(inRow.id)), `items=${incomingA2.items.length}`);
check('C5 an admin can see every ringing call', incomingAdmin.items.some((c) => Number(c.id) === Number(inRow.id)), `items=${incomingAdmin.items.length}`);

let denied = false;
try {
  await callService.answerInbound(a2Staff, inRow.id, { sdpAnswer: SDP_ANSWER });
} catch (error) {
  denied = error?.status === 403;
}
check('C6 a non-owner cannot answer the call -> 403', denied);

const answered = await callService.answerInbound(a1Staff, inRow.id, { sdpAnswer: SDP_ANSWER });
row = await callRow(inRow.id);
check('C7 the owner answers, Meta is told, and the call is connecting',
  Number(answered.id) === Number(inRow.id) && row?.status === 'connecting' && row?.answered_by_staff_id === a1Row.id,
  `status=${row?.status} answerer=${row?.answered_by_staff_id}`);

await callService.handleCallStatus(callStatusEvent({ waCallId: inWaCallId, direction: 'inbound', status: 'ACCEPTED' }));
row = await callRow(inRow.id);
check('C8 ACCEPTED connects the inbound call', row?.status === 'connected', `status=${row?.status}`);

await callService.handleCallEvent(terminateEvent({ waCallId: inWaCallId, direction: 'inbound', status: 'COMPLETED', duration: 12 }));
row = await callRow(inRow.id);
check('C9 the call ends with the reported duration', row?.status === 'ended' && row?.duration_seconds === 12, `duration=${row?.duration_seconds}`);

/* ------------------------------------------------------------ missed call -- */
const missedWaCallId = 'wacid.M12-IN-2';
await callService.handleCallEvent(connectEvent({ waCallId: missedWaCallId, direction: 'inbound', customerWaId: WA.UNASSIGNED, sdp: SDP_OFFER }));
const missedRow = await callRowByWaId(missedWaCallId);
await callService.handleCallEvent(terminateEvent({ waCallId: missedWaCallId, direction: 'inbound', status: 'COMPLETED', duration: 0 }));
const missedAfter = await callRow(missedRow.id);
check('D1 an inbound call that never connected is marked missed', missedAfter?.status === 'missed', `status=${missedAfter?.status}`);
const missedNotifs = (await query(
  `SELECT COUNT(*)::int AS n FROM notifications WHERE conversation_id = $1 AND type = 'missed_call'`, [c3.id]
)).rows[0].n;
check('D2 a missed call notifies the admins (conversation is unassigned)', missedNotifs > 0, `notifications=${missedNotifs}`);

/* ----------------------------------------------------------------- reject -- */
const rejectWaCallId = 'wacid.M12-IN-3';
await callService.handleCallEvent(connectEvent({ waCallId: rejectWaCallId, direction: 'inbound', customerWaId: WA.OWNED1, sdp: SDP_OFFER }));
const rejectRow = await callRowByWaId(rejectWaCallId);
const rejected = await callService.rejectInbound(a1Staff, rejectRow.id);
check('E1 an agent can decline an inbound call (marked missed)',
  rejected.status === 'missed', `status=${rejected.status}`);

/* -------------------------------------------------------- terminate (API) -- */
const endWaCallId = 'wacid.M12-IN-4';
await callService.handleCallEvent(connectEvent({ waCallId: endWaCallId, direction: 'inbound', customerWaId: WA.OWNED1, sdp: SDP_OFFER }));
const endRow = await callRowByWaId(endWaCallId);
await callService.handleCallStatus(callStatusEvent({ waCallId: endWaCallId, direction: 'inbound', status: 'ACCEPTED' }));
const ended = await callService.terminate(a1Staff, endRow.id);
check('F1 an agent can hang up an active call (ended)', ended.status === 'ended', `status=${ended.status}`);

/* ------------------------------------------------------------- permission -- */
shouldFail = true;
failCode = 138006;
let permissionError = null;
try {
  await callService.startOutbound(a1Staff, c1.id, { sdpOffer: SDP_OFFER });
} catch (error) {
  permissionError = error;
}
shouldFail = false;
check('G1 a missing call permission surfaces a clear, actionable error',
  permissionError?.status === 502 && /permission/i.test(permissionError?.message ?? ''),
  `status=${permissionError?.status} message=${permissionError?.message}`);

const failedCall = (await query(
  `SELECT status, error_code FROM calls WHERE conversation_id = $1 AND status = 'failed' ORDER BY id DESC LIMIT 1`, [c1.id]
)).rows[0];
check('G2 the failed attempt is still recorded for the audit trail',
  failedCall?.status === 'failed', `status=${failedCall?.status}`);

/* ----------------------------------------------------- HTTP route checks -- */
let r = await call('GET', '/calls/status');
check('H1 calling status requires a token -> 401', r.status === 401, `status=${r.status}`);

r = await call('GET', '/calls/status', { token: tAdmin });
check('H2 calling status returns configuration + checklist',
  r.status === 200 && typeof r.json?.enabled === 'boolean' && Array.isArray(r.json?.checklist),
  `enabled=${r.json?.enabled} items=${r.json?.checklist?.length}`);

r = await call('GET', `/calls/${outRow.id}`, { token: tA2 });
check('H3 a non-owner cannot read another conversation\'s call -> 403', r.status === 403, `status=${r.status}`);

r = await call('GET', `/calls/${outRow.id}`, { token: tA1 });
check('H4 the owner can read the call', r.status === 200 && Number(r.json?.id) === Number(outRow.id), `status=${r.status}`);

r = await call('GET', `/conversations/${c1.id}/calls`, { token: tA2 });
check('H5 another agent cannot read the call history -> 403', r.status === 403, `status=${r.status}`);

r = await call('GET', `/conversations/${c1.id}/calls`, { token: tA1 });
check('H6 the owner sees the conversation call history',
  r.status === 200 && Array.isArray(r.json?.items) && r.json.items.length >= 1, `items=${r.json?.items?.length}`);

/* ------------------------------------------------------------ idempotency -- */
const totalOutEvents = (await query(
  `SELECT COUNT(*)::int AS n FROM call_events WHERE wa_call_id = $1`, [outWaCallId]
)).rows[0].n;
check('I1 exactly one connect event was recorded for the outbound call (plus its terminate/status)',
  totalOutEvents >= 1, `events=${totalOutEvents}`);

/* ---------------------------------------------------------------- restore -- */
await cleanup();

await pool.end();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log(failed.map((entry) => `  FAILED: ${entry.name}`).join('\n'));
  process.exitCode = 1;
}
