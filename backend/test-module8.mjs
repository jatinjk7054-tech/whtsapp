/**
 * Module 8 — Agent Performance Analytics (Admin only).
 *
 *   node test-module8.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder). Meta's REST
 * API is stubbed exactly like module6/7 so the outbound regression at the end
 * proves "sending still works" without contacting WhatsApp. All performance
 * fixtures are inserted with explicit created_at timestamps inside an isolated
 * Jan 2099 window, so the expected totals are exact no matter what happened in
 * the live database on other dates. Cleanup removes the fixtures on the way out.
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M8-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M8-TEST-TOKEN';
process.env.WHATSAPP_AUTO_REPLY_ENABLED ||= 'false';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.M8-STUB-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }] }),
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

function inboundPayload(waId, text, { name = 'M8 Customer' } = {}) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name } }],
      messages: [{ from: waId, id: `wamid.M8-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

const WINDOW_FROM = '2099-01-01';
const WINDOW_TO = '2099-01-31';
const TZ_DEFAULT = 'Asia/Kolkata';

/* ------------------------------------------------------------ fixtures ---- */
const CONTACTS = {
  C1: '919876601701',
  C2: '919876601702',
  C3: '919876601703',
  C3B: '919876601704',
  C4: '919876601705',
  C5: '919876601706',
  C5B: '919876601707',
  C6: '919876601708',
};
const WA_AB = '919876601799';
const FIXTURES = [...Object.values(CONTACTS)];

async function cleanup() {
  for (const wa of FIXTURES) {
    await query(`DELETE FROM messages WHERE conversation_id IN (
      SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1)`, [wa]);
    await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)', [wa]);
    await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
  }
  await query('DELETE FROM contacts WHERE wa_id = $1', [WA_AB]);
  await query(`DELETE FROM messages WHERE conversation_id IN (
      SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1)`, [WA_AB]);
  await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)', [WA_AB]);
}

async function insertContact(waId, name) {
  const r = await query('INSERT INTO contacts (wa_id, name) VALUES ($1, $2) RETURNING id', [waId, name]);
  return r.rows[0].id;
}

async function insertConversation(contactId, assignedStaffId, status, createdAt) {
  const r = await query(
    `INSERT INTO conversations (contact_id, assigned_staff_id, status, last_message_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $4) RETURNING id`,
    [contactId, assignedStaffId, status, createdAt]
  );
  return r.rows[0].id;
}

async function insertMessage(conversationId, { direction, status, type, body, sentBy = null, createdAt, waMessageId = null, template = null }) {
  await query(
    `INSERT INTO messages (conversation_id, direction, status, type, body, sent_by_staff_id, wa_message_id, created_at,
                           template_name, template_language, template_params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      conversationId, direction, status, type, body, sentBy, waMessageId, createdAt,
      template?.name ?? null, template?.language ?? null, template?.params ?? null,
    ]
  );
}

/* ---------------------------------------------------------------- setup ---- */
await cleanup();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

const adminRow = (await query(`SELECT id FROM staff WHERE email = 'admin@example.com'`)).rows[0];
const a1Row = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0];
const a2Row = (await query(`SELECT id FROM staff WHERE email = 'agent2@example.com'`)).rows[0];
const ADMIN_ID = adminRow.id; // admin (role 'admin', never an agent row)
const A1 = a1Row.id; // agent "Agent 1"
const A2 = a2Row.id; // agent "Agent 2"
const activeAgents = (await query(`SELECT id FROM staff WHERE role = 'agent' AND is_active`)).rows.length;

/* ------------------------------------------------------ permissions (spec) - */
let r = await call('GET', '/admin/agent-performance');
check('A1 unauthenticated list -> 401', r.status === 401, `status=${r.status}`);
r = await call('GET', '/admin/agent-performance', { token: tA1 });
check('A2 agent list -> 403 (admin-only enforced on the backend)', r.status === 403, `status=${r.status}`);
r = await call('GET', `/admin/agent-performance/${A1}`, { token: tA1 });
check('A3 agent detail -> 403', r.status === 403, `status=${r.status}`);
r = await call('GET', '/admin/agent-performance', { token: tAdmin });
check('A4 admin list -> 200, default period has shape', r.status === 200 &&
  r.json?.period?.from && r.json?.period?.to && r.json?.period?.from <= r.json?.period?.to &&
  r.json?.period?.timezone && Array.isArray(r.json?.agents), `status=${r.status}`);

const awaySettings = (await query('SELECT timezone FROM away_message_settings WHERE id = 1')).rows[0];
check('A5 period timezone = the app timezone (away settings)', r.json?.period?.timezone === awaySettings.timezone,
  `${r.json?.period?.timezone} vs ${awaySettings.timezone}`);

/* ---------------------------------------------------------- fixtures (2099) - */
// Contact C1 owns 3 conversations (one open + two closed) so agents see the
// same customer across several handled chats -> customers stay distinct.
const c1 = await insertContact(CONTACTS.C1, 'M8 Customer A');
const c2 = await insertContact(CONTACTS.C2, 'M8 Customer B');
const c3 = await insertContact(CONTACTS.C3, 'M8 Customer C');
const c3b = await insertContact(CONTACTS.C3B, 'M8 Customer C2');
const c4 = await insertContact(CONTACTS.C4, 'M8 Customer D');
const c5 = await insertContact(CONTACTS.C5, 'M8 Customer E');
const c5b = await insertContact(CONTACTS.C5B, 'M8 Customer E2');
const c6 = await insertContact(CONTACTS.C6, 'M8 Unassigned');

// Agent 1 (@ a) -----------------------------------------------------------
const a1_day2 = '2099-01-02T04:00:00Z';
// ,open, C1: inbound + staff reply (+300s)
const ca1 = await insertConversation(c1, A1, 'open', a1_day2);
await insertMessage(ca1, { direction: 'inbound', status: 'received', type: 'text', body: 'hi A1', createdAt: '2099-01-02T04:00:00Z', waMessageId: 'wamid.M8.CA1.1' });
await insertMessage(ca1, { direction: 'outbound', status: 'sent', type: 'text', body: 'reply', sentBy: A1, createdAt: '2099-01-02T04:05:00Z', waMessageId: 'wamid.M8.CA1.2' });
// ,closed, C1: two inbounds then one reply (+600s) -> run-start collapses to ONE pair
const ca2 = await insertConversation(c1, A1, 'closed', '2099-01-02T05:00:00Z');
await insertMessage(ca2, { direction: 'inbound', status: 'received', type: 'text', body: 'q1', createdAt: '2099-01-02T05:00:00Z', waMessageId: 'wamid.M8.CA2.1' });
await insertMessage(ca2, { direction: 'inbound', status: 'received', type: 'text', body: 'q2 (same run)', createdAt: '2099-01-02T05:01:00Z', waMessageId: 'wamid.M8.CA2.2' });
await insertMessage(ca2, { direction: 'outbound', status: 'delivered', type: 'text', body: 'both answered', sentBy: A1, createdAt: '2099-01-02T05:10:00Z', waMessageId: 'wamid.M8.CA2.3' });
// ,closed, C1: inbound, never answered -> excluded from response time
const ca3 = await insertConversation(c1, A1, 'closed', '2099-01-02T06:00:00Z');
await insertMessage(ca3, { direction: 'inbound', status: 'received', type: 'text', body: 'unanswered', createdAt: '2099-01-02T06:00:00Z', waMessageId: 'wamid.M8.CA3.1' });
// ,pending, C2: inbound answered ONLY by the away message (no staff sender) -> not a response, not a message
const ca4 = await insertConversation(c2, A1, 'pending', '2099-01-02T07:00:00Z');
await insertMessage(ca4, { direction: 'inbound', status: 'received', type: 'text', body: 'off hours', createdAt: '2099-01-02T07:00:00Z', waMessageId: 'wamid.M8.CA4.1' });
await insertMessage(ca4, { direction: 'outbound', status: 'delivered', type: 'text', body: 'Away: we are closed (auto reply)', sentBy: null, createdAt: '2099-01-02T07:01:00Z', waMessageId: 'wamid.M8.CA4.2' });
// ,resolved, C3: inbound + FAILED staff send -> failed is never a response or a message
const ca5 = await insertConversation(c3, A1, 'resolved', '2099-01-05T04:00:00Z');
await insertMessage(ca5, { direction: 'inbound', status: 'received', type: 'text', body: 'plz reply', createdAt: '2099-01-05T04:00:00Z', waMessageId: 'wamid.M8.CA5.1' });
await insertMessage(ca5, { direction: 'outbound', status: 'failed', type: 'text', body: 'bounced', sentBy: A1, createdAt: '2099-01-05T04:10:00Z', waMessageId: 'wamid.M8.CA5.2' });
// ,open, C3b: inbound + TEMPLATE first response (+60s) + quick-reply text later
const ca6 = await insertConversation(c3b, A1, 'open', '2099-01-05T05:00:00Z');
await insertMessage(ca6, { direction: 'inbound', status: 'received', type: 'text', body: 'order?', createdAt: '2099-01-05T05:00:00Z', waMessageId: 'wamid.M8.CA6.1' });
await insertMessage(ca6, { direction: 'outbound', status: 'delivered', type: 'template', body: 'Thank you for your order…', sentBy: A1, createdAt: '2099-01-05T05:01:00Z', waMessageId: 'wamid.M8.CA6.2', template: { name: 'm8_welcome', language: 'en_US' } });
await insertMessage(ca6, { direction: 'outbound', status: 'sent', type: 'text', body: '/thankyou', sentBy: A1, createdAt: '2099-01-05T05:04:00Z', waMessageId: 'wamid.M8.CA6.3' });

// Agent 2 (@ b) -----------------------------------------------------------
// ,resolved, C4: inbound + agent reply (+180s)
const cb1 = await insertConversation(c4, A2, 'resolved', '2099-01-02T08:00:00Z');
await insertMessage(cb1, { direction: 'inbound', status: 'received', type: 'text', body: 'need help', createdAt: '2099-01-02T08:00:00Z', waMessageId: 'wamid.M8.CB1.1' });
await insertMessage(cb1, { direction: 'outbound', status: 'sent', type: 'text', body: 'helping', sentBy: A2, createdAt: '2099-01-02T08:03:00Z', waMessageId: 'wamid.M8.CB1.2' });
// ,closed, C4: inbound + reply written by the ADMIN (admins own every thread):
// the pair still lands on the conversation's assigned agent (@ b) — "friends claim".
const cb2 = await insertConversation(c4, A2, 'closed', '2099-01-02T09:00:00Z');
await insertMessage(cb2, { direction: 'inbound', status: 'received', type: 'text', body: 'admin queue', createdAt: '2099-01-02T09:00:00Z', waMessageId: 'wamid.M8.CB2.1' });
await insertMessage(cb2, { direction: 'outbound', status: 'sent', type: 'text', body: 'admin handled it', sentBy: ADMIN_ID, createdAt: '2099-01-02T09:01:30Z', waMessageId: 'wamid.M8.CB2.2' });
// ,pending, C5: inbound + QUEUED staff send -> queued is never a response or a message
const cb3 = await insertConversation(c5, A2, 'pending', '2099-01-05T06:00:00Z');
await insertMessage(cb3, { direction: 'inbound', status: 'received', type: 'text', body: 'queued?', createdAt: '2099-01-05T06:00:00Z', waMessageId: 'wamid.M8.CB3.1' });
await insertMessage(cb3, { direction: 'outbound', status: 'queued', type: 'text', body: 'still sending', sentBy: A2, createdAt: '2099-01-05T06:01:00Z', waMessageId: 'wamid.M8.CB3.2' });
// ,closed, C5b: inbound, never answered
const cb4 = await insertConversation(c5b, A2, 'closed', '2099-01-05T07:00:00Z');
await insertMessage(cb4, { direction: 'inbound', status: 'received', type: 'text', body: 'nobody home', createdAt: '2099-01-05T07:00:00Z', waMessageId: 'wamid.M8.CB4.1' });

// Unassigned conversation with messages -> excluded from every agent row
const cn = await insertConversation(c6, null, 'open', '2099-01-02T10:00:00Z');
await insertMessage(cn, { direction: 'inbound', status: 'received', type: 'text', body: 'no owner', createdAt: '2099-01-02T10:00:00Z', waMessageId: 'wamid.M8.CN.1' });
await insertMessage(cn, { direction: 'outbound', status: 'sent', type: 'text', body: 'admin send in unassigned', sentBy: ADMIN_ID, createdAt: '2099-01-02T10:05:00Z', waMessageId: 'wamid.M8.CN.2' });

const Q = `from=${WINDOW_FROM}&to=${WINDOW_TO}`;

/* ------------------------------------------------- main metrics (spec §A-D) - */
r = await call('GET', `/admin/agent-performance?${Q}`, { token: tAdmin });
check('B1 list 200 in the fixture window', r.status === 200, `status=${r.status}`);

const row = (id) => r.json.agents.find((a) => a.id === id);
const aRow = row(A1);
const bRow = row(A2);

check('B2 agent1 chats handled = 6', aRow?.chatsHandled === 6, `got ${aRow?.chatsHandled}`);
check('B3 agent1 customers = 4 (C1 counts once across three chats)', aRow?.customers === 4, `got ${aRow?.customers}`);
check('B4 agent1 open/pending/resolved/closed = 2/1/1/2 (sum = chats handled)', [
  aRow?.open === 2, aRow?.pending === 1, aRow?.resolved === 1, aRow?.closed === 2,
  aRow?.open + aRow?.pending + aRow?.resolved + aRow?.closed === aRow?.chatsHandled,
].every(Boolean), `o${aRow?.open} p${aRow?.pending} r${aRow?.resolved} c${aRow?.closed}`);
check('B5 agent1 messages sent = 4 (failed + away excluded; template + quick reply included)', aRow?.messagesSent === 4, `got ${aRow?.messagesSent}`);
check('B6 agent1 avg response = 320s (one pair per run, unanswered dropped)', aRow?.averageResponseTimeSeconds === 320, `got ${aRow?.averageResponseTimeSeconds}`);

check('C1 agent2 chats handled = 4', bRow?.chatsHandled === 4, `got ${bRow?.chatsHandled}`);
check('C2 agent2 customers = 3 (C4 counts once)', bRow?.customers === 3, `got ${bRow?.customers}`);
check('C3 agent2 status counts = 0/1/1/2', [
  bRow?.open === 0, bRow?.pending === 1, bRow?.resolved === 1, bRow?.closed === 2,
].every(Boolean), `o${bRow?.open} p${bRow?.pending} r${bRow?.resolved} c${bRow?.closed}`);
check('C4 agent2 messages sent = 1 (queued send not counted)', bRow?.messagesSent === 1, `got ${bRow?.messagesSent}`);
check('C5 agent2 avg response = 135s including the 90s ADMIN reply in his thread', bRow?.averageResponseTimeSeconds === 135, `got ${bRow?.averageResponseTimeSeconds}`);

check('D1 all other active agents read all zeros (no fake rows)', r.json.agents
  .filter((a) => a.id !== A1 && a.id !== A2)
  .every((a) => a.chatsHandled === 0 && a.messagesSent === 0 && a.customers === 0 &&
       a.open === 0 && a.pending === 0 && a.resolved === 0 && a.closed === 0), '');
check('D2 totalAgents = every active agent in the DB', r.json.totalAgents === activeAgents, `${r.json.totalAgents} vs ${activeAgents}`);

const s = r.json.summary;
check('E1 summary chats = 10 (6+4, unassigned excluded)', s.chatsHandled === 10, `got ${s.chatsHandled}`);
check('E2 summary messages = 5 (4+1; admin sends stay out of agent totals)', s.messagesSent === 5, `got ${s.messagesSent}`);
check('E3 summary customers = 7 (4+3, duplicates collapsed)', s.customers === 7, `got ${s.customers}`);
check('E4 summary avg response = 246s (weighted: 960+270 over 3+2)', s.averageResponseTimeSeconds === 246, `got ${s.averageResponseTimeSeconds}`);

/* ---------------------------------------------------- agent detail (spec §M-N) - */
r = await call('GET', `/admin/agent-performance/${A1}?${Q}`, { token: tAdmin });
const dA = r.json;
const day2 = dA.daily.find((d) => d.day === '2099-01-02');
const day5 = dA.daily.find((d) => d.day === '2099-01-05');
check('F1 agent1 detail 200 with 31 daily rows', r.status === 200 && dA.daily.length === 31, `rows=${dA.daily?.length}`);
check('F2 agent1 day 2099-01-02 = 4 chats / 2 customers / 2 messages', day2?.chats_handled === 4 && day2?.customers === 2 && day2?.messages_sent === 2,
  JSON.stringify(day2));
check('F3 agent1 day 2099-01-05 = 2 / 2 / 2 (failed not counted)', day5?.chats_handled === 2 && day5?.customers === 2 && day5?.messages_sent === 2,
  JSON.stringify(day5));
check('F4 all other days are zero (no leakage from other periods)', dA.daily
  .filter((d) => d.day !== '2099-01-02' && d.day !== '2099-01-05')
  .every((d) => d.chats_handled === 0 && d.customers === 0 && d.messages_sent === 0), '');

r = await call('GET', `/admin/agent-performance/${A2}?${Q}`, { token: tAdmin });
const dDay2 = r.json.daily.find((d) => d.day === '2099-01-02');
const dDay5 = r.json.daily.find((d) => d.day === '2099-01-05');
check('F5 agent2 day 2099-01-02 = 2 / 1 / 1', dDay2?.chats_handled === 2 && dDay2?.customers === 1 && dDay2?.messages_sent === 1, JSON.stringify(dDay2));
check('F6 agent2 day 2099-01-05 = 2 / 2 / 0 (queued send not counted)', dDay5?.chats_handled === 2 && dDay5?.customers === 2 && dDay5?.messages_sent === 0, JSON.stringify(dDay5));

r = await call('GET', `/admin/agent-performance/999?${Q}`, { token: tAdmin });
check('F7 detail for a non-existent agent -> 404', r.status === 404, `status=${r.status}`);

/* ---------------------------------------------------- sorting (spec §R-S) - */
const idx = (payload, id) => payload.json.agents.findIndex((a) => a.id === id);
const sorted = async (extra) => {
  const resp = await call('GET', `/admin/agent-performance?${Q}${extra}`, { token: tAdmin });
  return resp;
};
let sr = await sorted('&sort=chats&order=desc');
check('G1 sort chats desc -> agent1 before agent2', idx(sr, A1) < idx(sr, A2), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);
sr = await sorted('&sort=chats&order=asc');
check('G2 sort chats asc -> agent2 before agent1', idx(sr, A2) < idx(sr, A1), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);
sr = await sorted('&sort=messages&order=asc');
check('G3 sort messages asc -> agent2 (1) before agent1 (4)', idx(sr, A2) < idx(sr, A1), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);
sr = await sorted('&sort=customers&order=asc');
check('G4 sort customers asc -> agent2 (3) before agent1 (4)', idx(sr, A2) < idx(sr, A1), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);
sr = await sorted('&sort=response&order=asc');
check('G5 avg response asc (lower is better) -> 135s agent2 before 320s agent1',
  idx(sr, A2) < idx(sr, A1), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);
sr = await sorted('&sort=response&order=desc');
check('G6 avg response desc -> 320s agent1 before 135s agent2', idx(sr, A1) < idx(sr, A2), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);
sr = await sorted('&sort=open&order=desc');
check('G7 sort open desc -> agent1 (2) before agent2 (0)', idx(sr, A1) < idx(sr, A2), `a1=${idx(sr, A1)} a2=${idx(sr, A2)}`);

/* -------------------------------------------------- search (spec §N/Q) - */
sr = await sorted(`&search=${encodeURIComponent('AGENT2@example.com')}`);
check('H1 search by email (case-insensitive) -> only agent2', sr.json.agents.length === 1 && sr.json.agents[0].id === A2, `n=${sr.json.agents.length}`);
sr = await sorted('&search=nobody-with-this-name');
check('H2 search with no matches -> empty agent list', sr.json.agents.length === 0, `n=${sr.json.agents.length}`);
sr = await sorted(`&search=${encodeURIComponent('M8 Customer')}`);
check('H3 search for a CUSTOMER name -> empty (search only covers agent name/email)', sr.json.agents.length === 0, `n=${sr.json.agents.length}`);

sr = await sorted(`&agentId=${A2}`);
check('I1 filter agentId -> only agent2 with HIS summary', sr.json.agents.length === 1 && sr.json.agents[0].id === A2 &&
  sr.json.summary.chatsHandled === 4 && sr.json.summary.messagesSent === 1 &&
  sr.json.summary.customers === 3 && sr.json.summary.averageResponseTimeSeconds === 135,
  JSON.stringify(sr.json.summary));

/* ------------------------------------------------------- empty period - */
sr = await call('GET', '/admin/agent-performance?from=2098-01-01&to=2098-01-31', { token: tAdmin });
check('K1 empty period -> all agents zero, avg response null', sr.status === 200 &&
  sr.json.summary.chatsHandled === 0 && sr.json.summary.messagesSent === 0 &&
  sr.json.summary.customers === 0 && sr.json.summary.averageResponseTimeSeconds === null && sr.json.agents.length === activeAgents,
  JSON.stringify(sr.json.summary));

/* ------------------------------------------------------ validation - */
r = await call('GET', '/admin/agent-performance?from=2099-13-01', { token: tAdmin });
check('L1 month out of range -> 400 (friendly, not a 500)', r.status === 400, `status=${r.status}`);
r = await call('GET', '/admin/agent-performance?from=2099-02-01&to=2099-01-01', { token: tAdmin });
check('L2 from > to -> 400', r.status === 400, `status=${r.status}`);
r = await call('GET', '/admin/agent-performance?sort=bogus', { token: tAdmin });
check('L3 unknown sort key -> 400', r.status === 400, `status=${r.status}`);
r = await call('GET', '/admin/agent-performance?order=sideways', { token: tAdmin });
check('L4 unknown order -> 400', r.status === 400, `status=${r.status}`);
r = await call('GET', '/admin/agent-performance?agentId=0', { token: tAdmin });
check('L5 agentId 0 -> 400', r.status === 400, `status=${r.status}`);
r = await call('GET', `/admin/agent-performance/abc`, { token: tAdmin });
check('L6 non-numeric detail id -> 400', r.status === 400, `status=${r.status}`);

/* ---------------------------------------- regression: inbox & sending work - */
const awayBefore = (await call('GET', '/settings/away-message', { token: tAdmin })).json?.settings;
await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...awayBefore, enabled: false } });

await ingestWebhookPayload(inboundPayload(WA_AB, 'Module 8 regression: customer message'));
const abConv = (await query(
  `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1 ORDER BY c.id DESC LIMIT 1`,
  [WA_AB]
)).rows[0];
check('M1 inbound ingestion still creates a conversation (webhook path intact)', Boolean(abConv), String(abConv?.id));
await call('PUT', `/conversations/${abConv.id}/assign`, { token: tAdmin, body: { assignedStaffId: A1 } });
r = await call('POST', `/conversations/${abConv.id}/messages`, { token: tA1, body: { type: 'text', body: 'Module 8 regression reply' } });
const sentRow = (await query(`SELECT direction, status, sent_by_staff_id FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY id DESC LIMIT 1`, [abConv.id])).rows[0];
check('M2 agent can still send (Meta stub) -> outbound stored as sent',
  (r.status === 200 || r.status === 201) && sentRow?.direction === 'outbound' && sentRow?.status === 'sent' && sentRow?.sent_by_staff_id === A1,
  `status=${r.status} ${sentRow?.status}`);
r = await call('GET', '/conversations?sort=recent&limit=50&offset=0', { token: tA1 });
check('M3 inbox list still serves', r.status === 200 && Array.isArray(r.json?.items), `status=${r.status}`);

await call('PUT', '/settings/away-message', { token: tAdmin, body: awayBefore });

/* ------------------------------------------------------------------- end - */
await cleanup();
await pool.end();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);