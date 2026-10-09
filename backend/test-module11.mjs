/**
 * Module 11 — WhatsApp Message Delivery & Read Receipts.
 *
 *   node test-module11.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder) with a real
 * PostgreSQL database. Meta's Graph API is stubbed so the actual send path
 * (outbound.service -> client.call -> confirmOutboundMessage) is exercised, and
 * status webhooks are fed through the production ingest pipeline
 * (ingestWebhookPayload -> recordStatusEvent -> applyStatusEvent).
 *
 * It asserts the provider state machine end-to-end: pending -> sent ->
 * delivered -> read, terminal failed + retry, idempotent duplicates,
 * out-of-order non-downgrade, unknown-wamid reconciliation, inbound isolation,
 * non-text types and the existing conversation/agent permission model. It adds
 * NO new agent-assignment behaviour and every fixture is removed before exit.
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M11-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M11-TEST-TOKEN';
process.env.WHATSAPP_AUTO_REPLY_ENABLED ||= 'false';

let stubSeq = 0;
let shouldFail = false;
/** Captures outbound `status: read` calls so the read-receipt flow can be asserted. */
const readReceiptCalls = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    // Record a read receipt send (agent opened an unread conversation).
    try {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (body?.status === 'read' && body?.messaging_product === 'whatsapp') {
        readReceiptCalls.push(body.message_id);
      }
    } catch {
      /* not JSON — ignore */
    }

    if (shouldFail) {
      return new Response(
        JSON.stringify({
          error: { message: 'Simulated Meta rejection', code: 131026, type: 'OAuthException' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    stubSeq += 1;
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.M11-STUB-${Date.now()}-${stubSeq}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return originalFetch(input, init);
};

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { config } = await import('./src/config.js');
const { computeSignature } = await import('./src/lib/whatsapp/signature.js');
const {
  ingestWebhookPayload,
  whenIngestIdle,
} = await import('./src/conversations/inbound.service.js');
const {
  ensureMessageStatusSchema,
  insertOutboundMessage,
  confirmOutboundMessage,
  reconcileStatusEvents,
} = await import('./src/conversations/message.repository.js');
const { sendReply, retryOutboundMessage } = await import('./src/conversations/outbound.service.js');

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

let inboundSeq = 0;
function inboundPayload(waId, text, { name = 'M11 Customer' } = {}) {
  const wamid = `wamid.M11-IN-${Date.now()}-${(inboundSeq += 1)}`;
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name } }],
      messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

/** One Meta `statuses` webhook. `ts` defaults to now but is overridable. */
function statusPayload(wamid, status, { ts = Math.floor(Date.now() / 1000), error = null } = {}) {
  const entry = { id: wamid, status, timestamp: String(ts), recipient_id: '919000000000' };
  if (error) entry.errors = [{ code: error.code, title: error.title }];
  return { entry: [{ changes: [{ field: 'messages', value: { statuses: [entry] } }] }] };
}

async function ingest(payload) {
  await ingestWebhookPayload(payload);
  await whenIngestIdle();
}

const WEBHOOK_URL = `http://localhost:4000/webhooks/whatsapp`;

/** Posts a status webhook to the LIVE server exactly as Meta would (signed). */
async function postWebhook(payload, { signature } = {}) {
  const raw = JSON.stringify(payload);
  const sig = signature ?? `sha256=${computeSignature(raw, config.whatsapp.appSecret)}`;
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  return res.status;
}

/** Polls the DB for an expected status (the server ingests asynchronously). */
async function waitForStatus(id, status, attempts = 30) {
  let row = null;
  for (let i = 0; i < attempts; i += 1) {
    row = await messageRow(id);
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return row;
}

async function messageRow(id) {
  return (await query(
    `SELECT id, conversation_id, direction, status, wa_message_id, error_code, error_detail,
            delivered_at, read_receipt_at, status_updated_at
       FROM messages WHERE id = $1`,
    [id]
  )).rows[0] ?? null;
}

/* --------------------------------------------------------------- fixtures -- */
const WA = {
  OWNED1: '919876930101',
  OWNED2: '919876930102',
  UNASSIGNED: '919876930103',
};
const FIXTURES = Object.values(WA);

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
    await query('DELETE FROM message_status_events WHERE matched_message_id IN (SELECT id FROM messages WHERE conversation_id = ANY($1::int[]))', [convs]);
    await query('DELETE FROM notifications WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM reminders WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
  }
  await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
}

async function cleanup() {
  for (const wa of FIXTURES) await cleanupConversation(wa);
  // Any unmatched/stub events created by this run.
  await query("DELETE FROM message_status_events WHERE wa_message_id LIKE 'wamid.M11-%'");
}

/* ------------------------------------------------------------------ setup -- */
await cleanup();
await ensureMessageStatusSchema();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
const adminRow = (await query(`SELECT id FROM staff WHERE email = 'admin@example.com'`)).rows[0];
const a1Row = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0];
const a2Row = (await query(`SELECT id FROM staff WHERE email = 'agent2@example.com'`)).rows[0];
check('S1 tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

await seedConversation(WA.OWNED1, 'M11 Alpha', a1Row.id);
await seedConversation(WA.OWNED2, 'M11 Bravo', a2Row.id);
await seedConversation(WA.UNASSIGNED, 'M11 Charlie', null);

// Open the 24-hour window (and reuse the seeded open conversation in place).
await ingest(inboundPayload(WA.OWNED1, 'hello alpha'));
await ingest(inboundPayload(WA.OWNED2, 'hello bravo'));

const c1 = await conversationRow(WA.OWNED1);
const c2 = await conversationRow(WA.OWNED2);
check('S2 inbound reuses the seeded conversation and preserves its owner',
  c1.assigned_staff_id === a1Row.id && c2.assigned_staff_id === a2Row.id,
  `c1=${c1?.assigned_staff_id} c2=${c2?.assigned_staff_id}`);

/* ------------------------------------------------------------ permissions -- */
let r = await call('POST', `/conversations/${c1.id}/messages/999999/retry`);
check('P1 retry without a token -> 401', r.status === 401, `status=${r.status}`);

/* ------------------------------------------------- wamid on the real send -- */
// Driven in-process so the stubbed Graph API applies: the live server has its
// own real Meta credentials, which the in-test fetch stub cannot intercept.
const a1Staff = { id: a1Row.id, role: 'agent' };
const sent = await sendReply(a1Staff, c1.id, { body: 'Delivery receipt probe' });
const outboundId = sent.id;
const sentRow = await messageRow(outboundId);
check('A1 send stores a wamid and status sent',
  sentRow?.status === 'sent' && Boolean(sentRow?.wa_message_id),
  `dbStatus=${sentRow?.status} wamid=${sentRow?.wa_message_id}`);
const wamid = sentRow?.wa_message_id;

/* ------------------------------------------------------- delivered -> read -- */
await ingest(statusPayload(wamid, 'delivered'));
let row = await messageRow(outboundId);
check('A2 delivered event moves sent -> delivered and stamps delivered_at',
  row?.status === 'delivered' && Boolean(row?.delivered_at), `status=${row?.status}`);

await ingest(statusPayload(wamid, 'read'));
row = await messageRow(outboundId);
check('A3 read event moves delivered -> read and stamps read_receipt_at',
  row?.status === 'read' && Boolean(row?.read_receipt_at), `status=${row?.status}`);

/* ----------------------------------------------------- out-of-order guard -- */
await ingest(statusPayload(wamid, 'delivered', { ts: Math.floor(Date.now() / 1000) + 5 }));
row = await messageRow(outboundId);
check('A4 an older/duplicate delivered cannot downgrade read', row?.status === 'read', `status=${row?.status}`);

await ingest(statusPayload(wamid, 'sent', { ts: Math.floor(Date.now() / 1000) + 9 }));
row = await messageRow(outboundId);
check('A5 a late sent cannot downgrade read', row?.status === 'read', `status=${row?.status}`);

/* ------------------------------------------------------------ idempotency -- */
const dupTs = Math.floor(Date.now() / 1000) + 20;
await ingest(statusPayload(wamid, 'delivered', { ts: dupTs }));
await ingest(statusPayload(wamid, 'delivered', { ts: dupTs }));
const dupEvents = (await query(
  `SELECT COUNT(*)::int AS n FROM message_status_events
    WHERE wa_message_id = $1 AND status = 'delivered' AND event_timestamp = to_timestamp($2)`,
  [wamid, dupTs]
)).rows[0].n;
check('A6 a duplicate webhook is stored once and never re-applied',
  dupEvents === 1 && (await messageRow(outboundId))?.status === 'read', `rows=${dupEvents}`);

/* --------------------------------------------------------- failed + retry -- */
shouldFail = true;
try {
  await sendReply(a1Staff, c1.id, { body: 'This one will fail' });
} catch {
  /* the simulated Meta rejection is the point of this case */
}
shouldFail = false;
const failedId = (await query(
  `SELECT id FROM messages
    WHERE conversation_id = $1 AND direction = 'outbound' AND status = 'failed'
    ORDER BY id DESC LIMIT 1`,
  [c1.id]
)).rows[0]?.id;
let failedRow = failedId ? await messageRow(failedId) : null;
check('A7 a Meta rejection stores status failed with error details',
  failedRow?.status === 'failed' && failedRow?.error_code === 131026,
  `status=${failedRow?.status} code=${failedRow?.error_code}`);

// Permission gate fires before any send, so this never calls Meta.
r = await call('POST', `/conversations/${c1.id}/messages/${failedId}/retry`, { token: tA2 });
check('A8 another agent cannot retry your message -> 403', r.status === 403, `status=${r.status}`);

const retried = await retryOutboundMessage(a1Staff, c1.id, failedId);
failedRow = await messageRow(failedId);
check('A9 the owner retries the same failed row -> sent with a fresh wamid',
  retried.id === failedId && failedRow?.status === 'sent' && Boolean(failedRow?.wa_message_id),
  `dbStatus=${failedRow?.status}`);

// Now the row is 'sent': the status check throws 409 before any dispatch.
r = await call('POST', `/conversations/${c1.id}/messages/${failedId}/retry`, { token: tA1 });
check('A10 retrying a message that is no longer failed -> 409', r.status === 409, `status=${r.status}`);

/* ------------------------------------------------- unknown wamid reconcile -- */
const unknownWamid = `wamid.M11-UNKNOWN-${Date.now()}`;
await ingest(statusPayload(unknownWamid, 'delivered'));
const unmatchedBefore = (await query(
  `SELECT id, applied_at FROM message_status_events WHERE wa_message_id = $1`,
  [unknownWamid]
)).rows[0];
check('A11 a status for an unknown wamid is logged and left unmatched',
  Boolean(unmatchedBefore) && unmatchedBefore.applied_at === null, `applied=${unmatchedBefore?.applied_at}`);

// The message row lands afterwards (the race reconciliation is designed for).
const lateId = await insertOutboundMessage({
  conversationId: c1.id, sentByStaffId: a1Row.id, type: 'text', body: 'late arrival', mediaUrl: null,
});
await confirmOutboundMessage(lateId, unknownWamid);
await reconcileStatusEvents({ limit: 50 });
const lateRow = await messageRow(lateId);
const unmatchedAfter = (await query(
  `SELECT applied_at, matched_message_id FROM message_status_events WHERE wa_message_id = $1`,
  [unknownWamid]
)).rows[0];
check('A12 reconciliation applies the stored event once the row exists',
  lateRow?.status === 'delivered' && unmatchedAfter?.applied_at !== null && unmatchedAfter?.matched_message_id === lateId,
  `status=${lateRow?.status} applied=${unmatchedAfter?.applied_at}`);

/* ------------------------------------------------- inbound rows unaffected -- */
const inboundWamid = `wamid.M11-IN-DIRECT-${Date.now()}`;
await ingest({
  entry: [{ changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: WA.UNASSIGNED, profile: { name: 'M11 Charlie' } }],
    messages: [{ from: WA.UNASSIGNED, id: inboundWamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'inbound' } }],
  } }] }],
});
await ingest(statusPayload(inboundWamid, 'read'));
const inboundRow = (await query(
  `SELECT direction, status FROM messages WHERE wa_message_id = $1`, [inboundWamid]
)).rows[0];
check('A13 a status event never rewrites an inbound message',
  inboundRow?.direction === 'inbound' && inboundRow?.status === 'received',
  `direction=${inboundRow?.direction} status=${inboundRow?.status}`);

/* -------------------------------------------------- non-text types + perms -- */
const mediaWamid = `wamid.M11-MEDIA-${Date.now()}`;
const mediaId = await insertOutboundMessage({
  conversationId: c1.id, sentByStaffId: a1Row.id, type: 'image', body: '[image]', mediaUrl: '/api/media/test-media',
});
await confirmOutboundMessage(mediaId, mediaWamid);
await ingest(statusPayload(mediaWamid, 'delivered'));
const mediaRow = await messageRow(mediaId);
check('A14 an image message follows the same status lifecycle',
  mediaRow?.status === 'delivered', `status=${mediaRow?.status}`);

r = await call('GET', `/conversations/${c1.id}`, { token: tA1 });
const seen = (r.json?.messages ?? []).find((m) => m.id === outboundId);
check('A15 the thread refresh exposes the stored read status (Admin/owner view)',
  r.status === 200 && seen?.status === 'read', `status=${seen?.status}`);

r = await call('GET', `/conversations/${c1.id}`, { token: tA2 });
check('A16 another agent cannot open the conversation -> 403', r.status === 403, `status=${r.status}`);

r = await call('GET', `/conversations/${c1.id}`, { token: tAdmin });
const adminSeen = (r.json?.messages ?? []).find((m) => m.id === outboundId);
check('A17 an admin sees the same stored status', r.status === 200 && adminSeen?.status === 'read', `status=${adminSeen?.status}`);

/* --------------------------------------- live signed webhook round-trip -- */
// Proves the running server's real endpoint (signature verify -> parse ->
// handleStatus -> DB) works, not just the in-process ingest pipeline.
const whId = await insertOutboundMessage({
  conversationId: c1.id, sentByStaffId: a1Row.id, type: 'text', body: 'live webhook path', mediaUrl: null,
});
const whWamid = `wamid.M11-WH-${Date.now()}`;
await confirmOutboundMessage(whId, whWamid);

const whStatus = await postWebhook(statusPayload(whWamid, 'delivered'));
const whRow = await waitForStatus(whId, 'delivered');
check('A18 a signed status webhook POSTed to the live server is applied',
  whStatus === 200 && whRow?.status === 'delivered', `http=${whStatus} status=${whRow?.status}`);

const badSig = await postWebhook(statusPayload(whWamid, 'read'), { signature: 'sha256=deadbeef' });
const whRow2 = await messageRow(whId);
check('A19 a webhook with a bad signature is rejected (401) and changes nothing',
  badSig === 401 && whRow2?.status === 'delivered', `http=${badSig} status=${whRow2?.status}`);

r = await call('GET', `/conversations/${c1.id}`, { token: tA1 });
const whSeen = (r.json?.messages ?? []).find((m) => m.id === whId);
check('A20 the conversation API returns the webhook-updated status',
  whSeen?.status === 'delivered', `status=${whSeen?.status}`);

/* ------------------------------- regression: inbound MESSAGE reaches the app -- */
// Guards the reported regression: outbound delivered but inbound messages stopped
// showing up. A realistic signed `messages` webhook POSTed to the LIVE server
// must create the message row AND surface it through the same conversation API
// the frontend polls (GET /conversations/:id). A bad signature must be rejected.
const liveInbound = inboundPayload(WA.UNASSIGNED, 'regression inbound probe', { name: 'M11 Charlie' });
const liveWamid = liveInbound.entry[0].changes[0].value.messages[0].id;

const liveHttp = await postWebhook(liveInbound);
let liveRow = null;
for (let i = 0; i < 40 && !liveRow; i += 1) {
  liveRow = (await query('SELECT id, conversation_id, direction, status FROM messages WHERE wa_message_id = $1', [liveWamid])).rows[0] ?? null;
  if (!liveRow) await new Promise((resolve) => setTimeout(resolve, 100));
}
check('A21 a signed inbound MESSAGE webhook is accepted and persisted by the live server',
  liveHttp === 200 && liveRow?.direction === 'inbound' && liveRow?.status === 'received',
  `http=${liveHttp} direction=${liveRow?.direction} status=${liveRow?.status}`);

r = await call('GET', `/conversations/${liveRow?.conversation_id}`, { token: tAdmin });
const threadHit = (r.json?.messages ?? []).find(
  (m) => m.wa_message_id === liveWamid || m.waMessageId === liveWamid
);
check('A22 the inbound message is returned by the conversation API the frontend polls',
  r.status === 200 && Boolean(threadHit) && threadHit?.direction === 'inbound',
  `http=${r.status} found=${Boolean(threadHit)}`);

const rejectedInbound = inboundPayload(WA.UNASSIGNED, 'must not persist', { name: 'M11 Charlie' });
const rejectedWamid = rejectedInbound.entry[0].changes[0].value.messages[0].id;
const rejectedHttp = await postWebhook(rejectedInbound, { signature: 'sha256=deadbeef' });
await new Promise((resolve) => setTimeout(resolve, 300));
const rejectedRow = (await query('SELECT id FROM messages WHERE wa_message_id = $1', [rejectedWamid])).rows[0];
check('A23 an inbound MESSAGE webhook with a bad signature is rejected and never persisted',
  rejectedHttp === 401 && !rejectedRow, `http=${rejectedHttp} persisted=${Boolean(rejectedRow)}`);

/* ------------------------------------ regression: agent read sends read receipt -- */
// When an agent opens a conversation that has unread INBOUND messages, the
// backend must (a) mark them read locally and (b) send WhatsApp's read receipt
// for exactly those wamids. A silent background poll (markRead=false) must NOT
// send receipts, and a Meta failure must not break the thread response.
const { getThread } = await import('./src/conversations/conversation.service.js');
const a1StaffObj = { id: a1Row.id, role: 'agent' };

// Seed an unread inbound message into c1 (owned by agent1).
await ingest(inboundPayload(WA.OWNED1, 'read receipt probe', { name: 'M11 Alpha' }));
const unreadRow = (await query(
  `SELECT id, wa_message_id, read_at FROM messages
    WHERE conversation_id = $1 AND direction = 'inbound' AND read_at IS NULL
    ORDER BY id DESC LIMIT 1`,
  [c1.id]
)).rows[0];

readReceiptCalls.length = 0;
await getThread(a1StaffObj, c1.id, { markRead: true });
await new Promise((resolve) => setTimeout(resolve, 200));
const afterOpen = (await query('SELECT read_at FROM messages WHERE id = $1', [unreadRow.id])).rows[0];
check('A24 opening an unread conversation marks it read locally AND sends a WhatsApp read receipt',
  Boolean(afterOpen?.read_at) && readReceiptCalls.includes(unreadRow.wa_message_id),
  `read_at=${Boolean(afterOpen?.read_at)} receipts=${JSON.stringify(readReceiptCalls)}`);

// A second open (already read) must NOT send another receipt.
readReceiptCalls.length = 0;
await getThread(a1StaffObj, c1.id, { markRead: true });
await new Promise((resolve) => setTimeout(resolve, 150));
check('A25 re-opening an already-read conversation sends no duplicate receipt',
  readReceiptCalls.length === 0, `receipts=${JSON.stringify(readReceiptCalls)}`);

// A silent background poll must never mark read or send a receipt.
await ingest(inboundPayload(WA.OWNED1, 'silent poll probe', { name: 'M11 Alpha' }));
const unread2 = (await query(
  `SELECT id, wa_message_id FROM messages
    WHERE conversation_id = $1 AND direction = 'inbound' AND read_at IS NULL
    ORDER BY id DESC LIMIT 1`,
  [c1.id]
)).rows[0];
readReceiptCalls.length = 0;
await getThread(a1StaffObj, c1.id, { markRead: false });
await new Promise((resolve) => setTimeout(resolve, 150));
const afterSilent = (await query('SELECT read_at FROM messages WHERE id = $1', [unread2.id])).rows[0];
check('A26 a silent background poll (markRead=false) neither marks read nor sends a receipt',
  !afterSilent?.read_at && readReceiptCalls.length === 0,
  `read_at=${afterSilent?.read_at} receipts=${JSON.stringify(readReceiptCalls)}`);

// A Meta failure while sending the receipt must not break the thread response.
await ingest(inboundPayload(WA.OWNED1, 'failing receipt probe', { name: 'M11 Alpha' }));
shouldFail = true;
let threadStillOk = false;
try {
  const res = await getThread(a1StaffObj, c1.id, { markRead: true });
  threadStillOk = Boolean(res?.messages);
} catch {
  /* the thread response must not throw */
} finally {
  shouldFail = false;
}
check('A27 a Meta failure while sending the read receipt never breaks the thread response',
  threadStillOk, `threadOk=${threadStillOk}`);

/* ---------------------------------------------------------------- restore -- */
await cleanup();

await pool.end();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log(failed.map((entry) => `  FAILED: ${entry.name}`).join('\n'));
  process.exitCode = 1;
}
