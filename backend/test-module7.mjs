/**
 * Module 7 — Conversation Status Management (open | pending | resolved | closed).
 *
 *   node test-module7.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder). Webhook
 * ingests (handleInbound -> getOrCreateOpenConversation) run in THIS process,
 * so auto-reply and the away message are switched off here to keep the reopen
 * tests purely about status, and Meta's REST API is stubbed the same way as
 * module6. Agent replies that go through the live server hit the real Meta
 * API (credentials are in .env); the dummy +91... numbers are not real
 * WhatsApp users, so those sends fail on Meta's side and land as `failed`
 * rows — which is exactly what lets us assert "resolved is sendable"
 * (blocked statuses never even reach Meta).
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M7-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M7-TEST-TOKEN';
process.env.WHATSAPP_AUTO_REPLY_ENABLED = 'false';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.M7-STUB-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return originalFetch(input, init);
};

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { ingestWebhookPayload } = await import('./src/conversations/inbound.service.js');

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

function inboundPayload(waId, text, { name = 'M7 Customer' } = {}) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name } }],
      messages: [{ from: waId, id: `wamid.M7-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

const WA_OWN = '919876500701'; // agent1-owned: cycle / filters / search / perms
const WA_FOREIGN = '919876500702'; // agent2-owned: 403 on agent1's PATCH
const WA_UNASS = '919876500703'; // unassigned: only admin may move it
const WA_READD = '919876500704'; // resolved thread reopened by inbound
const WA_CLOSED = '919876500705'; // closed thread reopened by inbound
const WA_PEND = '919876500706'; // pending -> open, then open unchanged
const WA_SEND = '919876500707'; // resolved still sendable, closed blocked
const WA_EXTRA = '919876500708'; // third resolved thread for pagination
const FIXTURES = [WA_OWN, WA_FOREIGN, WA_UNASS, WA_READD, WA_CLOSED, WA_PEND, WA_SEND, WA_EXTRA];

async function cleanup() {
  for (const wa of FIXTURES) {
    await query(`DELETE FROM messages WHERE conversation_id IN (
      SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1)`, [wa]);
    await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)', [wa]);
    await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
  }
  const tag = (await query("SELECT id FROM tags WHERE name = 'M7-Status-Test'")).rows[0];
  if (tag) await query('DELETE FROM tags WHERE id = $1', [tag.id]);
}

async function convFor(waId) {
  const r = await query(
    'SELECT c.id, c.status, c.assigned_staff_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1 ORDER BY c.id DESC LIMIT 1',
    [waId]
  );
  return r.rows[0] ?? null;
}

async function historyRows(conversationId) {
  const r = await query(
    `SELECT h.old_status, h.new_status, h.changed_by FROM conversation_status_history h WHERE h.conversation_id = $1 ORDER BY h.id`,
    [conversationId]
  );
  return r.rows;
}

/* ------------------------------------------------------------- fixtures ---- */
await cleanup();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

// Away Message can send on inbound from the live DB — turn it off so the
// reopen tests count only status changes. Restored at the end.
const gone = await call('GET', '/settings/away-message', { token: tAdmin });
const awaySaved = gone.json?.settings;

async function awayOff() {
  await call('PUT', '/settings/away-message', {
    token: tAdmin,
    body: { ...awaySaved, enabled: false },
  });
}

await awayOff();

// ------------------------------------------------------------ A. shape -------
let r = await call('GET', '/health', { token: tAdmin });
check('A1 health ok', r.status === 200 && r.json?.status === 'ok', `status=${r.status}`);

r = await call('GET', '/conversations?view=all', { token: tAdmin });
const counts = r.json?.counts ?? {};
check('A2 list returns four status counts (zero-filled numbers)',
  r.status === 200 &&
    typeof counts.open === 'number' && typeof counts.pending === 'number' &&
    typeof counts.resolved === 'number' && typeof counts.closed === 'number' &&
    Object.keys(counts).sort().join(',') === 'closed,open,pending,resolved',
  JSON.stringify(counts));

// ---------------------------------------------------------- B. default -------
await ingestWebhookPayload(inboundPayload(WA_OWN, 'First message ever'));
let conv = await convFor(WA_OWN);
check('B1 inbound creates a conversation', Boolean(conv), String(conv?.id));
check('B2 new conversation defaults to open', conv?.status === 'open', conv?.status);

// Own the thread for the owner-scoped tests that follow.
r = await call('PUT', `/conversations/${conv.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
conv = await convFor(WA_OWN);
const convOwnId = conv.id;
check('B3 assigned to agent1 for owner tests', conv?.assigned_staff_id === 2, String(conv?.assigned_staff_id));

// -------------------------------- C. four-value cycle + history audit -------
let bodies = [
  ['pending', 'pending'],
  ['resolved', 'resolved'],
  ['closed', 'closed'],
  ['open', 'open'],
];
let expectedHistory = [];
for (const [patch, target] of bodies) {
  r = await call('PATCH', `/conversations/${conv.id}/status`, { token: tA1, body: { status: patch } });
  check(`C ${target}: PATCH ${patch} -> 200 & status=${target}`,
    r.status === 200 && r.json?.status === target, `status=${r.status} got=${r.json?.status}`);
  expectedHistory.push({ old: expectedHistory.at(-1)?.new ?? 'open', new: target });
}
const dbStatus = (await convFor(WA_OWN))?.status;
check('C after full cycle the DB keeps the last value (open)', dbStatus === 'open', dbStatus);

r = await call('GET', `/conversations/${conv.id}/status-history`, { token: tA1 });
const hist = r.json?.items ?? [];
check('C status-history lists every move, newest first',
  r.status === 200 && hist.length >= 4 && hist[0].new_status === 'open' && hist[0].old_status === 'closed',
  `rows=${hist.length} newest=${hist[0]?.new_status}`);
check('C history rows carry actor + timestamp',
  hist.every((row) => typeof row.changed_at === 'string') && hist[0].changed_by_id === 2 && typeof hist[0].changed_by_name === 'string',
  `actor=${hist[0]?.changed_by_id}`);

// -------------------------------------------------- D. validation -------
r = await call('PATCH', `/conversations/${conv.id}/status`, { token: tA1, body: { status: 'on-fire' } });
check('D1 unknown status -> 400', r.status === 400, `status=${r.status}`);
r = await call('PATCH', `/conversations/${conv.id}/status`, { token: tA1, body: {} });
check('D2 missing status -> 400', r.status === 400, `status=${r.status}`);
r = await call('PATCH', `/conversations/${conv.id}/status`, { body: { status: 'open' } });
check('D3 unauthenticated PATCH -> 401', r.status === 401, `status=${r.status}`);
r = await call('GET', `/conversations/${conv.id}/status-history`);
check('D4 unauthenticated history -> 401', r.status === 401, `status=${r.status}`);
r = await call('GET', '/conversations?status=devnull', { token: tA1 });
check('D5 invalid ?status= -> 400', r.status === 400, `status=${r.status}`);

// Avoid a 400 with an admin operator on a later `?assignedStaffId=` probe.
r = await call('GET', '/conversations?status=open&assignedStaffId=3', { token: tA1 });
check('D6 agent may not filter by assignee -> 403', r.status === 403, `status=${r.status}`);

// ---------------------------------------------- E. resolved list + counts ----
// Two more resolved threads: one owned by agent1 (WA_OWN is resolved below),
// one unassigned (WA_UNASS) and one owned by agent2 (WA_FOREIGN later).
r = await call('PATCH', `/conversations/${conv.id}/status`, { token: tA1, body: { status: 'resolved' } });
check('E prep: WA_OWN resolved', r.status === 200 && r.json?.status === 'resolved', `status=${r.status}`);

await ingestWebhookPayload(inboundPayload(WA_UNASS, 'Unassigned thread'));
conv = await convFor(WA_UNASS);
r = await call('PATCH', `/conversations/${conv.id}/status`, { token: tAdmin, body: { status: 'resolved' } });
check('E prep: unassigned thread resolved by admin', r.status === 200 && r.json?.status === 'resolved', `status=${r.status}`);

r = await call('GET', '/conversations?view=all&status=resolved', { token: tAdmin });
check('E1 ?status=resolved returns only resolved threads',
  r.status === 200 && r.json.items.length >= 2 &&
    r.json.items.every((item) => item.status === 'resolved'),
  `items=${r.json?.items?.length}`);

const before = await call('GET', '/conversations?view=all', { token: tAdmin });

// WA_EXTRA becomes the third resolved thread owned by agent2.
await ingestWebhookPayload(inboundPayload(WA_EXTRA, 'Extra thread'));
let convExtra = await convFor(WA_EXTRA);
await call('PUT', `/conversations/${convExtra.id}/assign`, { token: tAdmin, body: { assignedStaffId: 3 } });
r = await call('PATCH', `/conversations/${convExtra.id}/status`, { token: tA2, body: { status: 'resolved' } });
check('E prep: agent2-owned thread resolved', r.status === 200 && r.json?.status === 'resolved', `status=${r.status}`);

const after = await call('GET', '/conversations?view=all', { token: tAdmin });
check('E2 admin count is global: resolved +1 after one more resolved thread',
  after.json?.counts?.resolved === (before.json?.counts?.resolved ?? 0) + 1,
  `before=${before.json?.counts?.resolved} after=${after.json?.counts?.resolved}`);

// A delta an agent can NEVER own proves scoping: agent2 ignores WA_OWN.
const a2Before = await call('GET', '/conversations?view=mine', { token: tA2 });
await call('PATCH', `/conversations/${conv.id}/status`, { token: tA1, body: { status: 'pending' } });
const a2After = await call('GET', '/conversations?view=mine', { token: tA2 });
check('E3 agent counts are scoped (agent2 unaffected by agent1 moves)',
  (a2After.json?.counts?.pending ?? 0) === (a2Before.json?.counts?.pending ?? 0),
  `p2=${a2Before.json?.counts?.pending} -> ${a2After.json?.counts?.pending}`);
await call('PATCH', `/conversations/${conv.id}/status`, { token: tA1, body: { status: 'resolved' } });

// ------------------------------------------------------- F. permissions -------
r = await call('PATCH', `/conversations/${conv.id}/status`, { token: tA2, body: { status: 'open' } });
check('F1 agent cannot change another agent\u2019s conversation -> 403', r.status === 403, `status=${r.status}`);
r = await call('GET', `/conversations/${conv.id}/status-history`, { token: tA2 });
check('F2 agent cannot read another agent\u2019s history -> 403', r.status === 403, `status=${r.status}`);
r = await call('GET', `/conversations/${conv.id}/status-history`, { token: tAdmin });
check('F3 admin can read any history', r.status === 200 && Array.isArray(r.json?.items), `status=${r.status}`);

let convUnass = await convFor(WA_UNASS);
r = await call('PATCH', `/conversations/${convUnass.id}/status`, { token: tA1, body: { status: 'pending' } });
check('F4 agent cannot move an unassigned thread -> 403', r.status === 403, `status=${r.status}`);
r = await call('PATCH', `/conversations/${convUnass.id}/status`, { token: tAdmin, body: { status: 'pending' } });
check('F5 admin (or any admin) may move an unassigned thread',
  r.status === 200 && r.json?.status === 'pending', `status=${r.status}`);
await call('PATCH', `/conversations/${convUnass.id}/status`, { token: tAdmin, body: { status: 'resolved' } });

r = await call('GET', `/conversations/${convOwnId}`, { token: tA1 });
check('F6 thread still readable by owner after all this', r.status === 200, `status=${r.status}`);
r = await call('GET', '/conversations?status=missing&view=mine', { token: tA1 });
check('F7 invalid status -> 400 regardless of view', r.status === 400, `status=${r.status}`);

// Combined search + status (search matches the contact name).
await query(`UPDATE contacts SET name = 'Mango Mango Customer' WHERE wa_id = $1`, [WA_OWN]);
r = await call('GET', '/conversations?status=resolved&search=Mango', { token: tA1 });
check('G1 ?status=resolved&search=Mango finds the resolved thread',
  r.status === 200 && r.json.items.some((item) => item.contact_wa_id === WA_OWN), `items=${r.json?.items?.length}`);
r = await call('GET', '/conversations?status=pending&search=Mango', { token: tA1 });
check('G2 ...but ?status=pending&search=Mango excludes it',
  r.status === 200 && !r.json.items.some((item) => item.contact_wa_id === WA_OWN), `items=${r.json?.items?.length}`);

// Combined tag + status (tag the unassigned thread; ?tags= does ANY-match).
const mkTag = await call('POST', '/tags', { token: tAdmin, body: { name: 'M7-Status-Test', color: '#123456' } });
const tagId = mkTag.json?.id;
r = await call('POST', `/contacts/${WA_UNASS}/tags`, { token: tAdmin, body: { tagIds: [tagId] } });
check('H1 tag assigned to the unassigned thread', r.status === 200 && r.json?.tags?.some((t) => t.id === tagId), `status=${r.status}`);
r = await call('GET', `/conversations?status=resolved&tags=${tagId}`, { token: tAdmin });
check('H2 ?status=resolved&tags=<id> returns the tagged resolved thread',
  r.status === 200 && r.json.items.some((item) => item.contact_wa_id === WA_UNASS), `items=${r.json?.items?.length}`);
r = await call('GET', `/conversations?status=open&tags=${tagId}`, { token: tAdmin });
check('H3 ...but ?status=open&tags=<id> does not', r.status === 200 && r.json.items.length === 0, `items=${r.json?.items?.length}`);

// Pagination + status: pages are size-limited, never repeat and report the
// same grand total, whatever else lives in the database.
r = await call('GET', '/conversations?view=all&status=resolved&limit=1&offset=0', { token: tAdmin });
const pageA = r.json?.items ?? [];
const totalA = r.json?.total;
r = await call('GET', '/conversations?view=all&status=resolved&limit=1&offset=1', { token: tAdmin });
const pageB = r.json?.items ?? [];
const totalB = r.json?.total;
r = await call('GET', '/conversations?view=all&status=resolved&limit=1&offset=2', { token: tAdmin });
const pageC = r.json?.items ?? [];
const totalC = r.json?.total;
const ids = [...pageA, ...pageB, ...pageC].map((item) => item.id);
check('I1 status+pagination: every page holds only resolved rows',
  totalA >= 3 && totalA === totalB && totalA === totalC &&
    pageA.length === 1 && pageB.length === 1 && pageC.length === 1 &&
    [...pageA, ...pageB, ...pageC].every((item) => item.status === 'resolved'),
  `total=${totalA}`);
check('I2 status+pagination: no page repeats a thread, totals match',
  new Set(ids).size === ids.length && new Set(ids).size >= 3, `ids=${new Set(ids).size}/${ids.length}`);
r = await call('GET', '/conversations?view=all&status=resolved&limit=2&offset=900', { token: tAdmin });
check('I3 out-of-range offset -> empty page, real total preserved',
  r.status === 200 && r.json.items.length === 0 && r.json.total === totalA, `total=${r.json?.total}`);

// ------------------------------------------- J. inbound reopens RESOLVED -----
let convR = await convFor(WA_READD);
if (!convR) {
  await ingestWebhookPayload(inboundPayload(WA_READD, 'Initial'));
  convR = await convFor(WA_READD);
}
await call('PUT', `/conversations/${convR.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
await call('PATCH', `/conversations/${convR.id}/status`, { token: tA1, body: { status: 'resolved' } });
const convRId = convR.id;
const histBefore = await historyRows(convRId);
const histBeforeCount = histBefore.length;

await ingestWebhookPayload(inboundPayload(WA_READD, 'We are still waiting for the receipt'));
convR = await convFor(WA_READD);
check('J1 inbound reopens a resolved thread to open', convR?.status === 'open', convR?.status);
check('J2 reopen keeps the SAME conversation (no duplicate)',
  convR?.id === convRId, `expected=${convRId} got=${convR?.id}`);
check('J3 reopen preserves the assignment', convR?.assigned_staff_id === 2, String(convR?.assigned_staff_id));
const histAfter = await historyRows(convRId);
check('J4 reopen wrote a system history row (resolved -> open, changed_by NULL)',
  histAfter.length === histBeforeCount + 1 &&
    histAfter.at(-1).old_status === 'resolved' && histAfter.at(-1).new_status === 'open' &&
    histAfter.at(-1).changed_by === null,
  JSON.stringify(histAfter.map((h) => `${h.old_status}->${h.new_status}`)));

// ------------------------------------------------- K. inbound reopens CLOSED --
let convC = await convFor(WA_CLOSED);
if (!convC) {
  await ingestWebhookPayload(inboundPayload(WA_CLOSED, 'Initial'));
  convC = await convFor(WA_CLOSED);
}
await call('PUT', `/conversations/${convC.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
await call('PATCH', `/conversations/${convC.id}/status`, { token: tA1, body: { status: 'closed' } });
const convCId = convC.id;
const histBeforeC = await historyRows(convCId).then((rows) => rows.length);

await ingestWebhookPayload(inboundPayload(WA_CLOSED, 'Coming back after Closure'));
convC = await convFor(WA_CLOSED);
check('K1 inbound reopens a closed thread to open', convC?.status === 'open', convC?.status);
check('K2 reopened-in-place (module 2 behaviour preserved)', convC?.id === convCId, `id=${convC?.id}`);
check('K3 assignment survives the closed -> open reopen', convC?.assigned_staff_id === 2, String(convC?.assigned_staff_id));
const histAfterC = await historyRows(convCId);
check('K4 reopen of closed records old=closed new=open (system)',
  histAfterC.length === histBeforeC + 1 &&
    histAfterC.at(-1).new_status === 'open' && histAfterC.at(-1).changed_by === null,
  JSON.stringify(histAfterC.map((h) => `${h.old_status}->${h.new_status}`)));

// ------------------------------------- L. pending reopens; open stays put -----
let convP = await convFor(WA_PEND);
if (!convP) {
  await ingestWebhookPayload(inboundPayload(WA_PEND, 'Initial'));
  convP = await convFor(WA_PEND);
}
await call('PUT', `/conversations/${convP.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
await call('PATCH', `/conversations/${convP.id}/status`, { token: tA1, body: { status: 'pending' } });
const convPId = convP.id;

await ingestWebhookPayload(inboundPayload(WA_PEND, 'Customer replies while pending'));
convP = await convFor(WA_PEND);
check('L1 pending thread reopens to open on inbound (spec \u00a716)', convP?.status === 'open', convP?.status);
check('L2 reopen of pending is in place, no duplicate', convP?.id === convPId, `id=${convP?.id}`);

const histP1 = await historyRows(convPId);
await ingestWebhookPayload(inboundPayload(WA_PEND, 'And again while already open'));
const histP2 = await historyRows(convPId);
convP = await convFor(WA_PEND);
check('L3 already-open thread stays open and writes no history row',
  convP?.status === 'open' && histP2.length === histP1.length, `h=${histP1.length}->${histP2.length}`);

// ------------------------------ M. outbound gates: resolved free, closed hard --
let convS = await convFor(WA_SEND);
if (!convS) {
  await ingestWebhookPayload(inboundPayload(WA_SEND, 'Initial'));
  convS = await convFor(WA_SEND);
}
await call('PUT', `/conversations/${convS.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
await call('PATCH', `/conversations/${convS.id}/status`, { token: tA1, body: { status: 'resolved' } });

const sentBefore = await query(
  `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
  [convS.id]
).then((rows) => rows.rows[0].n);

r = await call('POST', `/conversations/${convS.id}/messages`, { token: tA1, body: { type: 'text', body: 'Apologies for the delay' } });
check('M1 resolved thread is NOT send-blocked (no 409/403)',
  r.status !== 409 && r.status !== 403, `status=${r.status} ${r.json?.error ?? ''}`);
const sentAfter = await query(
  `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
  [convS.id]
).then((rows) => rows.rows[0].n);
check('M2 the reply actually went to Meta (message written)',
  sentAfter === sentBefore + 1, `rows ${sentBefore}->${sentAfter}`);

await call('PATCH', `/conversations/${convS.id}/status`, { token: tA1, body: { status: 'closed' } });
r = await call('POST', `/conversations/${convS.id}/messages`, { token: tA1, body: { type: 'text', body: 'Please reopen me' } });
check('M3 closed thread is still hard-blocked (module 2 gate intact)',
  r.status === 409 && /closed/i.test(r.json?.error ?? ''), `status=${r.status}`);
const sentFinal = await query(
  `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
  [convS.id]
).then((rows) => rows.rows[0].n);
check('M4 the blocked send wrote nothing', sentFinal === sentAfter, `same=${sentAfter}`);

// ------------------------------------------------- N. assign/claim + history --
// assign of a closed thread reopens it AND records who did it.
let convN = await convFor(WA_EXTRA);
await call('PATCH', `/conversations/${convN.id}/status`, { token: tA2, body: { status: 'closed' } });
let histN = await historyRows(convN.id);
r = await call('PUT', `/conversations/${convN.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
check('N1 admin assign reopens a closed thread',
  r.status === 200 && r.json?.status === 'open' && r.json?.assigned_staff_id === 2,
  `status=${r.status} st=${r.json?.status}`);
const histN2 = await historyRows(convN.id);
check('N2 assign recorded closed -> open with the admin as actor',
  histN2.length === histN.length + 1 &&
    histN2.at(-1).old_status === 'closed' && histN2.at(-1).new_status === 'open' &&
    histN2.at(-1).changed_by !== null,
  JSON.stringify(histN2.map((h) => `${h.old_status}->${h.new_status}`)));

// claim of a non-closed thread changes ownership but NOT status -> no row.
const unassignedClaim = await convFor(WA_UNASS); // resolved + unassigned
const histClaimBefore = await historyRows(unassignedClaim.id).then((rows) => rows.length);
r = await call('POST', `/conversations/${unassignedClaim.id}/claim`, { token: tAdmin });
const histClaimAfter = await historyRows(unassignedClaim.id);
check('N3 admin can claim an unassigned thread (status stays resolved)',
  r.status === 200 && r.json?.assigned_staff_id === 1 && r.json?.status === 'resolved',
  `status=${r.status} who=${r.json?.assigned_staff_id} st=${r.json?.status}`);
check('N4 claim of a non-closed thread adds no history row',
  histClaimAfter.length === histClaimBefore, `h=${histClaimBefore}->${histClaimAfter.length}`);

// an agent may not assign at all (route is admin-only) — same as before M7.
r = await call('PUT', `/conversations/${convN.id}/assign`, { token: tA1, body: { assignedStaffId: 3 } });
check('N5 agent assign attempt -> 403 (module 2 rule intact)', r.status === 403, `status=${r.status}`);

// ------------------------------------------------- O. history endpoint shape ----
r = await call('GET', '/conversations/999999999/status-history', { token: tAdmin });
check('O1 history of a missing conversation -> 404', r.status === 404, `status=${r.status}`);
r = await call('GET', `/conversations/${convRId}/status-history`, { token: tA1 });
check('O2 history lists the reopen trail for the resolved thread',
  r.status === 200 && r.json?.items?.length >= 2 &&
    r.json.items.every((row) => ['open', 'pending', 'resolved', 'closed'].includes(row.old_status) &&
      ['open', 'pending', 'resolved', 'closed'].includes(row.new_status)),
  `rows=${r.json?.items?.length}`);

// -------------------------------------------- P. regression: unread filter ----
r = await call('GET', '/conversations?view=unread', { token: tA1 });
check('P1 unread view still works alongside the new statuses', r.status === 200, `status=${r.status}`);

// ------------------------------------------------------- Q. regressions -------
r = await call('GET', '/tags', { token: tAdmin });
check('Q1 tags catalogue intact (module 5)', r.status === 200 && Array.isArray(r.json?.items), `status=${r.status}`);
r = await call('GET', '/quick-replies', { token: tA1 });
check('Q2 quick replies intact (module 6)', r.status === 200, `status=${r.status}`);
r = await call('GET', '/settings/away-message', { token: tAdmin });
check('Q3 away-message endpoint intact (module 6)', r.status === 200, `status=${r.status}`);
r = await call('GET', `/contacts/${WA_OWN}/profile`, { token: tAdmin });
check('Q4 customer profile intact (module 1)', r.status === 200 && Boolean(r.json?.contact), `status=${r.status}`);
r = await call('GET', '/conversations?view=mine', { token: tA2 });
check('Q5 agent inbox intact (module 2)', r.status === 200, `status=${r.status}`);

// --------------------------------------------------------------- T. schema -----
const constraint = await query(
  `SELECT pg_get_constraintdef(oid)::text AS def
     FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'`
);
check('T1 conversations.status CHECK allows all four values',
  ['open', 'pending', 'resolved', 'closed'].every((value) => constraint.rows[0]?.def.includes(value)),
  constraint.rows[0]?.def);
const histTable = await query(`SELECT to_regclass('public.conversation_status_history') AS rel`);
check('T2 status history table exists', histTable.rows[0]?.rel !== null, String(histTable.rows[0]?.rel));

// ----------------------------------------------------------- U. no-op PATCH ----
const histU = await historyRows(convRId);
r = await call('PATCH', `/conversations/${convRId}/status`, { token: tA1, body: { status: 'open' } });
const histU2 = await historyRows(convRId);
check('U1 PATCH same status -> 200, no extra history row',
  r.status === 200 && histU2.length === histU.length, `rows ${histU.length}->${histU2.length}`);

// -------------------------------------------------------------- Y. full loop ----
const loopConv = await convFor(WA_FOREIGN);
if (!loopConv) {
  await ingestWebhookPayload(inboundPayload(WA_FOREIGN, 'First for the loop'));
}
let lc = await convFor(WA_FOREIGN);
await call('PUT', `/conversations/${lc.id}/assign`, { token: tAdmin, body: { assignedStaffId: 3 } });
await call('PATCH', `/conversations/${lc.id}/status`, { token: tA2, body: { status: 'pending' } });
await call('PATCH', `/conversations/${lc.id}/status`, { token: tA2, body: { status: 'resolved' } });
const loopId = lc.id;
const loopHistoryBefore = await historyRows(loopId).then((rows) => rows.length);
await ingestWebhookPayload(inboundPayload(WA_FOREIGN, 'Loop: customer writes again'));
lc = await convFor(WA_FOREIGN);
const loopHistoryAfter = await historyRows(loopId);
check('Y1 full loop: pending -> resolved -> inbound -> open',
  lc?.status === 'open' && lc?.id === loopId, `status=${lc?.status}`);
check('Y2 full loop: history records the reopen', loopHistoryAfter.length === loopHistoryBefore + 1, `h=${loopHistoryBefore}->${loopHistoryAfter.length}`);

// ----------------------------------------------------------------------- end --
await call('PUT', '/settings/away-message', { token: tAdmin, body: awaySaved });
await cleanup();
await pool.end();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);