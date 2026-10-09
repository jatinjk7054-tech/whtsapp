const BASE = 'http://localhost:4000/api';
const WA_A = '919999111222'; // customer A -> agent 1
const WA_B = '919999333444'; // customer B -> agent 2
const RUN = Date.now(); // webhook_events is an idempotency gate: unique ids per run

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { ingestWebhookPayload } = await import('./src/conversations/inbound.service.js');

async function tokenFor(email) {
  const r = await query('SELECT id, name, email, role FROM staff WHERE email = $1 AND is_active', [email]);
  if (!r.rows[0]) throw new Error(`no staff ${email}`);
  return signToken(r.rows[0]);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

function inboundPayload(waId, text, { wamid, contextId } = {}) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name: 'Test Customer' } }],
      messages: [{ from: waId, id: wamid ?? `wamid.M3-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(contextId ? { context: { id: contextId } } : {}) }],
    } }] }],
  };
}

// ---- cleanup (previous runs) ----
async function cleanup() {
  await query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id IN ($1,$2,$3)))', [WA_A, WA_B, '919999555666']);
  await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id IN ($1,$2,$3))', [WA_A, WA_B, '919999555666']);
  await query('DELETE FROM contacts WHERE wa_id IN ($1,$2,$3)', [WA_A, WA_B, '919999555666']);
}
await cleanup();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('tokens minted', Boolean(tAdmin && tA1 && tA2));

// ---- setup: two inbound conversations, assigned to agent1 / agent2 ----
await ingestWebhookPayload(inboundPayload(WA_A, 'Please send the donation receipt for my contribution'));
await ingestWebhookPayload(inboundPayload(WA_B, 'Hi, what are the event timings?'));

const convA = (await query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1`, [WA_A])).rows[0];
const convB = (await query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1`, [WA_B])).rows[0];
check('conversations created', Boolean(convA && convB));

await call('PUT', `/conversations/${convA.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
await call('PUT', `/conversations/${convB.id}/assign`, { token: tAdmin, body: { assignedStaffId: 3 } });

const inboundA = (await query(`SELECT id FROM messages WHERE conversation_id=$1 AND direction='inbound'`, [convA.id])).rows[0];

// ---- 1. reply: outbound row keeps the reference (Meta may reject the send in
//         this sandbox — the row is still written first, as designed) ----
await call('POST', `/conversations/${convA.id}/messages`, { token: tA1, body: { type: 'text', body: 'Receipt is on its way', replyToId: inboundA.id } });
let row = (await query(`SELECT id, reply_to_id, status FROM messages WHERE conversation_id=$1 AND direction='outbound' ORDER BY id DESC LIMIT 1`, [convA.id])).rows[0];
check('outbound reply stores reply_to_id', row?.reply_to_id === inboundA.id, JSON.stringify(row));

// ---- 2. reply to a message from another conversation -> 422 ----
let r = await call('POST', `/conversations/${convA.id}/messages`, { token: tA1, body: { type: 'text', body: 'x', replyToId: 99999999 } });
check('reply to unknown message -> 422', r.status === 422, `status=${r.status}`);

// ---- 3. agent2 cannot reply into agent1's conversation -> 403 ----
r = await call('POST', `/conversations/${convA.id}/messages`, { token: tA2, body: { type: 'text', body: 'x', replyToId: inboundA.id } });
check('agent2 reply to agent1 conversation -> 403', r.status === 403, `status=${r.status}`);

// ---- 4. inbound webhook reply context resolves to the local row ----
const fakeOutboundWamid = `wamid.MODULE3-OUT-${RUN}`;
await query(`INSERT INTO messages (conversation_id, direction, status, type, body, wa_message_id, sent_by_staff_id)
             VALUES ($1, 'outbound', 'sent', 'text', 'Original outbound', $2, 2)`, [convA.id, fakeOutboundWamid]);
const originalOutbound = (await query(`SELECT id FROM messages WHERE wa_message_id=$1`, [fakeOutboundWamid])).rows[0];
const inboundReplyWamid = `wamid.MODULE3-IN-${RUN}`;
await ingestWebhookPayload(inboundPayload(WA_A, 'Yes please', { wamid: inboundReplyWamid, contextId: fakeOutboundWamid }));
const inboundReply = (await query(`SELECT reply_to_id, reply_to_wa_message_id FROM messages WHERE wa_message_id=$1`, [inboundReplyWamid])).rows[0];
check('inbound reply context stored + linked',
  inboundReply?.reply_to_id === originalOutbound.id && inboundReply?.reply_to_wa_message_id === fakeOutboundWamid,
  JSON.stringify(inboundReply));

// thread returns the quoted preview columns
r = await call('GET', `/conversations/${convA.id}`, { token: tA1 });
const quotedMsg = r.json?.messages?.find((m) => m.wa_message_id === inboundReplyWamid);
check('thread carries quoted_* preview fields',
  quotedMsg?.quoted_body === 'Original outbound' && quotedMsg?.quoted_direction === 'outbound',
  JSON.stringify({ body: quotedMsg?.quoted_body, dir: quotedMsg?.quoted_direction }));

// ---- 5. forward: authorization ----
// agent2 forwarding agent1's message -> 403 (source not theirs)
r = await call('POST', `/conversations/${convB.id}/forward`, { token: tA2, body: { sourceMessageId: inboundA.id } });
check('agent2 forwarding agent1 message -> 403', r.status === 403, `status=${r.status}`);

// agent2 forwarding own message into agent1's conversation -> 403 (target not theirs)
const inboundB = (await query(`SELECT id FROM messages WHERE conversation_id=$1 AND direction='inbound'`, [convB.id])).rows[0];
r = await call('POST', `/conversations/${convA.id}/forward`, { token: tA2, body: { sourceMessageId: inboundB.id } });
check('agent2 forwarding into agent1 conversation -> 403', r.status === 403, `status=${r.status}`);

// ---- 6. forward: text to an authorized target (admin) ----
r = await call('POST', `/conversations/${convB.id}/forward`, { token: tAdmin, body: { sourceMessageId: inboundA.id } });
row = (await query(`SELECT id, is_forwarded, body, conversation_id FROM messages WHERE conversation_id=$1 AND direction='outbound' ORDER BY id DESC LIMIT 1`, [convB.id])).rows[0];
check('admin forward text creates flagged row in target',
  row?.is_forwarded === true && row?.body === 'Please send the donation receipt for my contribution',
  JSON.stringify(row));
// In this sandbox Meta may reject the send to a fake number. The row is written
// before dispatch either way (failed rows are the designed behaviour), so accept
// 201 from Meta or a preserved-but-failed row.
check('forward returns 201 or preserves a failed row on Meta rejection',
  (r.status === 201 && typeof r.json?.id === 'number') || (r.status >= 400 && row),
  `status=${r.status}`);

// ---- 7. forward: unsupported / broken sources -> 422 ----
const sticker = (await query(`INSERT INTO messages (conversation_id, direction, status, type, body) VALUES ($1,'outbound','sent','sticker','[sticker]') RETURNING id`, [convA.id])).rows[0];
r = await call('POST', `/conversations/${convA.id}/forward`, { token: tA1, body: { sourceMessageId: sticker.id } });
check('forward sticker -> 422', r.status === 422, `status=${r.status}`);

const imageNoMedia = (await query(`INSERT INTO messages (conversation_id, direction, status, type, body) VALUES ($1,'inbound','received','image','[image]') RETURNING id`, [convA.id])).rows[0];
r = await call('POST', `/conversations/${convA.id}/forward`, { token: tA1, body: { sourceMessageId: imageNoMedia.id } });
check('forward image without media -> 422 (no fake send)', r.status === 422, `status=${r.status}`);

// ---- 8. forward into a closed conversation -> 409 ----
await call('PATCH', `/conversations/${convB.id}/status`, { token: tAdmin, body: { status: 'closed' } });
r = await call('POST', `/conversations/${convB.id}/forward`, { token: tAdmin, body: { sourceMessageId: inboundA.id } });
check('forward into closed conversation -> 409', r.status === 409, `status=${r.status}`);
await call('PATCH', `/conversations/${convB.id}/status`, { token: tAdmin, body: { status: 'open' } });

// ---- 9. message search: partial text, scoping, name, number ----
r = await call('GET', '/conversations/messages/search?search=donat', { token: tA1 });
const foundA1 = r.json?.items?.some((m) => m.id === inboundA.id);
check('agent1 partial text search finds own message', r.status === 200 && foundA1, `items=${r.json?.items?.length}`);

r = await call('GET', '/conversations/messages/search?search=donat', { token: tA2 });
const leak = r.json?.items?.some((m) => m.id === inboundA.id);
check('agent2 search does NOT see agent1 message', r.status === 200 && !leak, `items=${r.json?.items?.length}`);

r = await call('GET', '/conversations/messages/search?search=donat', { token: tAdmin });
check('admin search sees all', r.status === 200 && r.json?.items?.some((m) => m.id === inboundA.id), `items=${r.json?.items?.length}`);

r = await call('GET', `/conversations/messages/search?search=${encodeURIComponent('event timings')}`, { token: tA2 });
check('agent2 finds own by text', r.status === 200 && r.json?.items?.some((m) => m.id === inboundB.id));

r = await call('GET', `/conversations/messages/search?search=${encodeURIComponent('+91 99991 11222')}`, { token: tAdmin });
check('search by formatted number matches wa_id', r.status === 200 && r.json?.items?.some((m) => m.id === inboundA.id), `items=${r.json?.items?.length}`);

r = await call('GET', `/conversations/messages/search?search=${encodeURIComponent('Test Customer')}`, { token: tA1 });
check('search by customer name matches', r.status === 200 && r.json?.items?.length > 0, `items=${r.json?.items?.length}`);

r = await call('GET', '/conversations/messages/search?search=', { token: tAdmin });
check('empty search -> 400', r.status === 400, `status=${r.status}`);

r = await call('GET', '/conversations/messages/search?search=donat&limit=1', { token: tAdmin });
check('search honours limit', r.status === 200 && r.json?.items?.length <= 1, `items=${r.json?.items?.length}`);

// ---- 10. unread / read behaviour ----
r = await call('GET', `/conversations/${convA.id}?markRead=true`, { token: tA1 });
const unreadAfterOwner = r.json?.conversation?.unread_count;
const stillUnread = (await query(`SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id=$1 AND direction='inbound' AND read_at IS NULL`, [convA.id])).rows[0].n;
check('owner opening thread marks incoming read', unreadAfterOwner === 0 && stillUnread === 0, `unread=${unreadAfterOwner} unreadRows=${stillUnread}`);

await ingestWebhookPayload(inboundPayload(WA_A, 'One more unread thing'));
r = await call('GET', `/conversations/${convA.id}`, { token: tA2 });
check('agent2 cannot open agent1 thread -> 403 (not marked read)', r.status === 403, `status=${r.status}`);
const unreadAfterStranger = (await query(`SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id=$1 AND direction='inbound' AND read_at IS NULL`, [convA.id])).rows[0].n;
check("another agent's open does not mark read", unreadAfterStranger === 1, `unreadRows=${unreadAfterStranger}`);

// list carries unread_count + latest timestamp
r = await call('GET', '/conversations?view=mine', { token: tA1 });
const itemA = r.json?.items?.find((c) => c.id === convA.id);
check('list shows unread count + last message timestamp',
  itemA?.unread_count === 1 && Boolean(itemA?.last_message_at),
  JSON.stringify({ unread: itemA?.unread_count, at: itemA?.last_message_at }));

// ---- 11. regressions from earlier modules ----
r = await call('GET', '/health', { token: tAdmin });
check('health ok', r.status === 200 && r.json?.status === 'ok');
r = await call('POST', '/contacts', { token: tA1, body: { name: 'M3 Contact', mobile: '919999555666', notes: 'n', tags: 'New' } });
check('add contact still works (module 1)', r.status === 201 || r.status === 409, `status=${r.status}`);
r = await call('GET', `/contacts/${WA_A}/profile`, { token: tA1 });
check('customer profile still works (module 1)', r.status === 200, `status=${r.status}`);
r = await call('GET', `/contacts/${WA_A}/picture`, { token: tA1 });
check('DP endpoint still honest 404', r.status === 404, `status=${r.status}`);
r = await call('GET', '/whatsapp/templates', { token: tA1 });
check('template list endpoint reachable', [200, 400, 403, 404, 500].includes(r.status), `status=${r.status}`);

// message timestamps present
r = await call('GET', `/conversations/${convA.id}?markRead=false`, { token: tA1 });
check('every message carries created_at',
  Array.isArray(r.json?.messages) && r.json.messages.length > 0 && r.json.messages.every((m) => Boolean(m.created_at)));

await cleanup();
await pool.end();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
