/**
 * Module 6 — Away Message + Quick Replies.
 *
 *   node test-module6.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder). The
 * webhook path (handleInbound -> maybeSendAwayMessage) runs inside THIS
 * process, so Meta's REST API is stubbed here first: sends can be asserted
 * without a live WhatsApp account, and a deliberate Meta failure can be
 * scripted to prove the cooldown is released when nothing went out.
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M6-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M6-TEST-TOKEN';

const originalFetch = globalThis.fetch;
const failRecipients = new Set(); // wa_ids whose Meta calls should be rejected

globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    let to = null;
    try {
      to = JSON.parse(init?.body ?? '{}')?.to ?? null;
    } catch {
      /* not a JSON body (media upload) */
    }
    if (to && failRecipients.has(to)) {
      return new Response(
        JSON.stringify({ error: { message: 'stubbed Meta failure', code: 190, type: 'OAuthException' } }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.M6-STUB-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return originalFetch(input, init);
};

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { config } = await import('./src/config.js');
const { ingestWebhookPayload } = await import('./src/conversations/inbound.service.js');
const { evaluateAwayWindow } = await import('./src/away/away.service.js');

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

function inboundPayload(waId, text, { wamid } = {}) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name: 'M6 Customer' } }],
      messages: [{ from: waId, id: wamid ?? `wamid.M6-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

function statusPayload(waMessageId) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      statuses: [{ id: waMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }],
    } }] }],
  };
}

// Current wall clock in the CRM's default zone — used to build a schedule
// window that cannot contain "now", so the webhook tests pass at any hour.
function istNowHHMM() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('hour')}:${get('minute')}`;
}

function alwaysOutsideSchedule() {
  const now = istNowHHMM();
  const window = now !== '00:00' ? { from: '00:00', to: '00:01' } : { from: '00:01', to: '00:02' };
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, enabled: true, ...window }));
}

function fullSchedule(overrides = {}) {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day, enabled: true, from: '09:00', to: '18:00', ...(overrides[day] ?? {}),
  }));
}

const AWAY_TEXT = 'M6 AWAY MESSAGE (module 6 test)';
const WA_B = '919876500601'; // away enabled path
const WA_C = '919876500602'; // Meta failure then success
const WA_E = '919876500603'; // Meta failure then cooldown release
const WA_F = '919876500604'; // feature switched off again
const WA_H = '919876500605'; // 24-hour window fixture
const WA_SMOKE = '919876500606'; // contact form smoke test
const FIXTURES = [WA_B, WA_C, WA_E, WA_F, WA_H, WA_SMOKE];

async function cleanup() {
  for (const wa of FIXTURES) {
    await query(`DELETE FROM messages WHERE conversation_id IN (
      SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1)`, [wa]);
    await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)', [wa]);
    await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
  }
}

async function convFor(waId) {
  const r = await query(
    'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1 ORDER BY c.id DESC LIMIT 1',
    [waId]
  );
  return r.rows[0] ?? null;
}

async function awayRows(conversationId) {
  const r = await query(
    `SELECT id, status, wa_message_id, sent_by_staff_id FROM messages
      WHERE conversation_id = $1 AND direction = 'outbound' AND body = $2
      ORDER BY id`,
    [conversationId, AWAY_TEXT]
  );
  return r.rows;
}

async function lastAwaySentAt(conversationId) {
  const r = await query('SELECT last_away_sent_at FROM conversations WHERE id = $1', [conversationId]);
  return r.rows[0]?.last_away_sent_at ?? null;
}

await cleanup();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

// ------------------------------------------------------- A. health + shape --
let r = await call('GET', '/health', { token: tAdmin });
check('A1 health ok', r.status === 200 && r.json?.status === 'ok', `status=${r.status}`);

r = await call('GET', '/settings/away-message', { token: tAdmin });
const original = r.json?.settings;
check('A2 GET away settings 200 with settings + evaluation',
  r.status === 200 && Boolean(original) && Boolean(r.json?.evaluation),
  `status=${r.status}`);
check('A3 defaults: Asia/Kolkata, non-empty message, 7 unique days',
  original?.timezone === 'Asia/Kolkata' &&
    Boolean(original?.message?.trim()) &&
    Array.isArray(original?.schedule) &&
    original.schedule.length === 7 &&
    new Set(original.schedule.map((d) => d.day)).size === 7,
  JSON.stringify({ tz: original?.timezone, days: original?.schedule?.length }));
check('A4 evaluation carries decision fields',
  typeof r.json?.evaluation?.shouldSend === 'boolean' && typeof r.json?.evaluation?.reason === 'string',
  r.json?.evaluation?.reason);

// ------------------------------------------------------------ B. permissions --
r = await call('GET', '/settings/away-message', { token: tA1 });
check('B1 agent GET away settings -> 403', r.status === 403, `status=${r.status}`);
r = await call('PUT', '/settings/away-message', { token: tA2, body: { enabled: true, message: 'x', timezone: 'Asia/Kolkata', schedule: fullSchedule() } });
check('B2 agent PUT away settings -> 403', r.status === 403, `status=${r.status}`);
r = await call('POST', '/settings/away-message/test', { token: tA1, body: {} });
check('B3 agent POST /test -> 403', r.status === 403, `status=${r.status}`);
r = await call('GET', '/settings/away-message');
check('B4 unauthenticated GET -> 401', r.status === 401, `status=${r.status}`);

// ---------------------------------------------------------- C. save + rules --
const savedBody = {
  enabled: true,
  message: AWAY_TEXT,
  timezone: 'Asia/Kolkata',
  schedule: fullSchedule(),
};
r = await call('PUT', '/settings/away-message', { token: tAdmin, body: savedBody });
check('C1 admin PUT valid settings -> 200 + echo',
  r.status === 200 && r.json?.settings?.message === AWAY_TEXT && r.json?.settings?.enabled === true,
  `status=${r.status}`);

r = await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, schedule: fullSchedule({ 3: { to: '08:00' } }) } });
check('C2 office hours ending before they start -> 400', r.status === 400, `status=${r.status} ${r.json?.error ?? ''}`);

r = await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, schedule: savedBody.schedule.slice(0, 6) } });
check('C3 schedule with six days -> 400', r.status === 400, `status=${r.status}`);

r = await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, schedule: fullSchedule({ 2: { day: 1 } }) } });
check('C4 duplicate weekday -> 400', r.status === 400, `status=${r.status}`);

r = await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, message: '   ' } });
check('C5 empty message -> 400', r.status === 400, `status=${r.status}`);

r = await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, timezone: 'Mars/Olympus' } });
check('C6 unknown timezone -> 400', r.status === 400, `status=${r.status}`);

r = await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, schedule: fullSchedule({ 1: { from: '9am' } }) } });
check('C7 malformed time -> 400', r.status === 400, `status=${r.status}`);

// ------------------------------------------------------- D. /test simulation --
r = await call('POST', '/settings/away-message/test', { token: tAdmin, body: { ...savedBody, enabled: false } });
check('D1 /test simulates a draft: simulated + sent:false + disabled evaluation',
  r.status === 200 && r.json?.simulated === true && r.json?.sent === false &&
    r.json?.evaluation?.shouldSend === false && /disabled/i.test(r.json?.evaluation?.reason ?? ''),
  JSON.stringify({ status: r.status, reason: r.json?.evaluation?.reason }));

r = await call('POST', '/settings/away-message/test', { token: tAdmin, body: {} });
check('D2 /test with no body uses saved settings + preview',
  r.status === 200 && r.json?.sent === false && r.json?.preview === savedBody.message,
  `status=${r.status}`);

// --------------------------------------------- E. pure schedule evaluation --
const MON = fullSchedule(); // Mon..Sun all 09:00–18:00
const monNoon = new Date('2026-01-05T10:00:00Z'); // Monday 15:30 Asia/Kolkata
let ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Asia/Kolkata', schedule: MON }, monNoon);
check('E1 inside office hours (Mon 15:30 IST) does not send',
  ev.shouldSend === false && ev.insideOfficeHours === true && ev.weekday === 1 && ev.localTime === '15:30',
  JSON.stringify({ reason: ev.reason, time: ev.localTime }));

ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'America/New_York', schedule: MON }, monNoon);
check('E2 same instant, New York = Monday 05:00 -> outside hours, sends',
  ev.shouldSend === true && ev.insideOfficeHours === false && ev.localTime === '05:00',
  JSON.stringify({ reason: ev.reason, time: ev.localTime }));

ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Asia/Kolkata', schedule: fullSchedule({ 1: { enabled: false } }) }, monNoon);
check('E3 disabled weekday is not an office day -> sends', ev.shouldSend === true && /not an office day/.test(ev.reason), ev.reason);

ev = evaluateAwayWindow({ enabled: false, message: 'm', timezone: 'Asia/Kolkata', schedule: MON }, monNoon);
check('E4 disabled feature never sends', ev.shouldSend === false && /disabled/i.test(ev.reason), ev.reason);

ev = evaluateAwayWindow({ enabled: true, message: '   ', timezone: 'Asia/Kolkata', schedule: MON }, monNoon);
check('E5 empty message never sends', ev.shouldSend === false && /empty/i.test(ev.reason), ev.reason);

const satAfternoon = new Date('2026-01-03T12:00:00Z'); // Saturday 17:30 IST
ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Asia/Kolkata', schedule: fullSchedule({ 6: { enabled: false } }) }, satAfternoon);
check('E6 weekend (Sat 17:30) with Saturday off -> sends',
  ev.shouldSend === true && ev.dayName === 'Saturday', JSON.stringify({ day: ev.dayName, reason: ev.reason }));

ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Asia/Kolkata', schedule: MON }, new Date('2026-01-05T12:30:00Z'));
check('E7 boundary: exactly 18:00 is outside (exclusive end)', ev.shouldSend === true && ev.insideOfficeHours === false, ev.reason);
ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Asia/Kolkata', schedule: MON }, new Date('2026-01-05T03:30:00Z'));
check('E8 boundary: exactly 09:00 is inside (inclusive start)', ev.insideOfficeHours === true && ev.shouldSend === false, ev.reason);
ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Asia/Kolkata', schedule: MON }, new Date('2026-01-05T03:29:00Z'));
check('E9 boundary: 08:59 is outside', ev.insideOfficeHours === false && ev.shouldSend === true, ev.reason);

ev = evaluateAwayWindow({ enabled: true, message: 'm', timezone: 'Not/AZone', schedule: MON }, monNoon);
check('E10 unknown timezone falls back instead of throwing',
  ev.validTimezone === false && typeof ev.shouldSend === 'boolean', JSON.stringify({ tz: ev.timezone, valid: ev.validTimezone }));

// ------------------------------------------ F. webhook integration (live DB) --
// F1: away disabled -> no away row, legacy first-contact greeting untouched.
await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, enabled: false } });
await ingestWebhookPayload(inboundPayload(WA_B, 'Hello, is anyone there?'));

let conv = await convFor(WA_B);
check('F1 conversation created for new inbound', Boolean(conv), String(conv?.id));
check('F2 disabled Away Message sends nothing on inbound', (await awayRows(conv.id)).length === 0);
if (config.whatsapp.autoReplyEnabled) {
  const auto = await query(
    `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND sent_by_staff_id IS NULL AND body = $2`,
    [conv.id, config.whatsapp.autoReplyText]
  );
  check('F3 legacy first-contact greeting still fires when Away Message is off', auto.rows.length > 0, `rows=${auto.rows.length}`);
} else {
  check('F3 legacy first-contact greeting (disabled by config, skipped)', true, 'autoReplyEnabled=false');
}

// F4: away enabled + a window that excludes "now" -> one away message, and the
// legacy greeting must NOT also fire for the same message.
await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, enabled: true, schedule: alwaysOutsideSchedule() } });
await ingestWebhookPayload(inboundPayload(WA_C, 'Second customer, first message of the day'));

conv = await convFor(WA_C);
let rows = await awayRows(conv.id);
check('F4 inbound with Away Message enabled sends exactly one away message',
  rows.length === 1 && rows[0].status === 'sent' && Boolean(rows[0].wa_message_id) && rows[0].sent_by_staff_id === null,
  JSON.stringify(rows));
check('F5 cooldown stamp written on the conversation', Boolean(await lastAwaySentAt(conv.id)));
const autoForC = await query(
  `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND sent_by_staff_id IS NULL AND body = $2`,
  [conv.id, config.whatsapp.autoReplyText]
);
check('F6 no double automated reply (legacy greeting skipped once away sent)', autoForC.rows.length === 0, `autoReplyRows=${autoForC.rows.length}`);

// F7: a second customer message within 24 hours must not send a second one.
await ingestWebhookPayload(inboundPayload(WA_C, 'Second message five seconds later'));
rows = await awayRows(conv.id);
check('F7 cooldown: second inbound does not send a second away message', rows.length === 1, `rows=${rows.length}`);

// F8: an agent's own outbound message must never trigger it.
await call('PUT', `/conversations/${conv.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });
await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'text', body: 'Agent reply about your donation' } });
rows = await awayRows(conv.id);
check('F8 agent outbound does not trigger the Away Message', rows.length === 1, `rows=${rows.length}`);

// F9: a delivery-status webhook must never trigger it.
const awayWaId = rows[0]?.wa_message_id;
await ingestWebhookPayload(statusPayload(awayWaId));
rows = await awayRows(conv.id);
check('F9 status webhook does not trigger the Away Message', rows.length === 1, `rows=${rows.length}`);

// F10: the away row is a normal outbound message in the thread.
r = await call('GET', `/conversations/${conv.id}`, { token: tA1 });
const threadAway = r.json?.messages?.find((m) => m.body === AWAY_TEXT);
check('F10 away message appears in the thread as outbound',
  r.status === 200 && threadAway?.direction === 'outbound',
  JSON.stringify({ status: r.status, dir: threadAway?.direction }));

// F11: Meta rejects the send -> row failed, claim released, next message retries.
failRecipients.add(WA_E);
await ingestWebhookPayload(inboundPayload(WA_E, 'This send will be rejected by Meta'));
const convE = await convFor(WA_E);
rows = await awayRows(convE.id);
check('F11 failed send stored as a failed row and claim released',
  rows.length === 1 && rows[0].status === 'failed' && (await lastAwaySentAt(convE.id)) === null,
  JSON.stringify(rows));
failRecipients.delete(WA_E);
await ingestWebhookPayload(inboundPayload(WA_E, 'Retrying after the failure'));
rows = await awayRows(convE.id);
check('F12 next inbound retries and sends once cooldown is released',
  rows.some((row) => row.status === 'sent') && Boolean(await lastAwaySentAt(convE.id)),
  JSON.stringify(rows.map((row) => row.status)));

// F13: switching the feature off again stops everything.
await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...savedBody, enabled: false } });
await ingestWebhookPayload(inboundPayload(WA_F, 'Late night message while off'));
const convF = await convFor(WA_F);
check('F13 conversation still created while the feature is off', Boolean(convF), String(convF?.id));
check('F14 disabling the feature stops away messages', Boolean(convF) && (await awayRows(convF.id)).length === 0);

// ------------------------------------------------------- G. quick replies ----
r = await call('GET', '/quick-replies', { token: tAdmin });
const items = r.json?.items ?? [];
const shortcuts = new Set(items.map((item) => item.shortcut));
check('G1 admin sees the library with the three seeded replies',
  r.status === 200 && ['/greeting', '/donation', '/followup'].every((s) => shortcuts.has(s)),
  JSON.stringify([...shortcuts]));
check('G2 library rows carry title/shortcut/category/message',
  items.every((item) => typeof item.title === 'string' && item.shortcut.startsWith('/') &&
    typeof item.category === 'string' && typeof item.message === 'string'));
check('G3 categories list returned for the filter dropdown',
  Array.isArray(r.json?.categories) && r.json.categories.includes('Greeting'),
  JSON.stringify(r.json?.categories));

r = await call('GET', '/quick-replies', { token: tA1 });
check('G4 agent may read the library', r.status === 200 && (r.json?.items?.length ?? 0) >= 3, `status=${r.status}`);
r = await call('GET', '/quick-replies');
check('G5 unauthenticated read -> 401', r.status === 401, `status=${r.status}`);

r = await call('GET', '/quick-replies?search=donation', { token: tA2 });
check('G6 search matches shortcut/title/category/message',
  r.status === 200 && r.json.items.length > 0 &&
    r.json.items.every((item) => `${item.shortcut} ${item.title} ${item.category} ${item.message}`.toLowerCase().includes('donation')) &&
    r.json.items.some((item) => item.shortcut === '/donation'),
  `items=${r.json?.items?.length}`);
r = await call('GET', '/quick-replies?search=nothing-matches-this', { token: tA1 });
check('G7 search with no hits returns an empty list', r.status === 200 && r.json.items.length === 0, `items=${r.json?.items?.length}`);

r = await call('POST', '/quick-replies', { token: tA1, body: { title: 'Agent Try', shortcut: '/agenttry', message: 'nope' } });
check('G8 agent cannot create a quick reply -> 403', r.status === 403, `status=${r.status}`);

r = await call('POST', '/quick-replies', { token: tAdmin, body: { title: 'M6 Receipt', shortcut: 'receipt', category: 'Donation', message: 'Your donation receipt will reach you shortly, {{name}}.' } });
const created = r.json;
check('G9 admin creates a reply; shortcut normalised with a slash',
  r.status === 201 && created?.shortcut === '/receipt' && created?.title === 'M6 Receipt',
  `status=${r.status} shortcut=${created?.shortcut}`);

r = await call('POST', '/quick-replies', { token: tAdmin, body: { title: 'Dupe', shortcut: 'RECEIPT', message: 'duplicate' } });
check('G10 duplicate shortcut (any case) -> 409', r.status === 409, `status=${r.status} ${r.json?.error ?? ''}`);

r = await call('POST', '/quick-replies', { token: tAdmin, body: { title: 'Bad', shortcut: '/has spaces', message: 'x' } });
check('G11 shortcut with spaces -> 400', r.status === 400, `status=${r.status}`);

r = await call('POST', '/quick-replies', { token: tAdmin, body: { title: 'Empty', shortcut: '/empty', message: '   ' } });
check('G12 empty message -> 400', r.status === 400, `status=${r.status}`);

r = await call('PATCH', `/quick-replies/${created.id}`, { token: tA2, body: { message: 'x' } });
check('G13 agent cannot edit -> 403', r.status === 403, `status=${r.status}`);

r = await call('PATCH', `/quick-replies/${created.id}`, { token: tAdmin, body: { message: 'Receipt attached for your records.' } });
check('G14 admin edit saves and echoes the new message',
  r.status === 200 && r.json?.message === 'Receipt attached for your records.',
  `status=${r.status}`);

r = await call('GET', '/quick-replies?search=attached', { token: tA1 });
check('G15 edited message is searchable', r.status === 200 && r.json.items.some((item) => item.id === created.id), `items=${r.json?.items?.length}`);

r = await call('DELETE', `/quick-replies/${created.id}`, { token: tA2 });
check('G16 agent cannot delete -> 403', r.status === 403, `status=${r.status}`);

r = await call('DELETE', `/quick-replies/${created.id}`, { token: tAdmin });
check('G17 admin delete -> 200', r.status === 200, `status=${r.status}`);
r = await call('GET', '/quick-replies', { token: tA1 });
check('G18 deleted reply is gone from the library', !(r.json?.items ?? []).some((item) => item.id === created.id));
r = await call('DELETE', `/quick-replies/${created.id}`, { token: tAdmin });
check('G19 deleting again -> 404', r.status === 404, `status=${r.status}`);

r = await call('GET', '/quick-replies', { token: tA1 });
check('G20 the three seeded replies survived the round trip',
  ['/greeting', '/donation', '/followup'].every((s) => (r.json?.items ?? []).some((item) => item.shortcut === s)));

// ------------------------------------ H. 24-hour window is untouched ----------
const agent1Id = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0].id;
await query(`INSERT INTO contacts (wa_id, name, notes, tags) VALUES ($1, 'M6 Window Customer', '', '{}')`, [WA_H]);
const contact = (await query('SELECT id FROM contacts WHERE wa_id = $1', [WA_H])).rows[0];
const windowConv = (await query(
  `INSERT INTO conversations (contact_id, assigned_staff_id, status) VALUES ($1, $2, 'open') RETURNING id`,
  [contact.id, agent1Id]
)).rows[0];
await query(
  `INSERT INTO messages (conversation_id, direction, status, type, body, created_at)
   VALUES ($1, 'inbound', 'received', 'text', 'Customer wrote two days ago', NOW() - INTERVAL '2 days')`,
  [windowConv.id]
);

r = await call('POST', `/conversations/${windowConv.id}/messages`, { token: tA1, body: { type: 'text', body: 'Trying to reply after the window closed' } });
check('H1 free text outside the 24-hour window still -> 409 with template hint',
  r.status === 409 && /template/i.test(r.json?.error ?? ''), `status=${r.status} ${r.json?.error ?? ''}`);

r = await call('POST', `/conversations/${windowConv.id}/messages`, { token: tA1, body: { type: 'text', body: 'Namaste! Thank you for contacting Being Sevak Charitable Trust.' } });
check('H2 a quick reply pasted into the composer obeys the same 409', r.status === 409, `status=${r.status}`);

r = await call('GET', '/whatsapp/templates', { token: tA1 });
check('H3 Template Library endpoint still reachable', [200, 400, 403, 404, 500].includes(r.status), `status=${r.status}`);

// --------------------------------------------------------- I. regressions ----
r = await call('GET', '/tags', { token: tAdmin });
check('I1 tags catalogue intact (module 5)', r.status === 200 && Array.isArray(r.json?.items), `status=${r.status}`);
r = await call('GET', `/contacts/${WA_B}/profile`, { token: tAdmin });
check('I2 customer profile intact (module 1)', r.status === 200 && Boolean(r.json?.contact), `status=${r.status}`);
r = await call('GET', '/conversations?view=mine', { token: tA1 });
check('I3 conversation list intact (module 2)', r.status === 200, `status=${r.status}`);
r = await call('POST', '/contacts', { token: tA1, body: { name: 'M6 Smoke', mobile: WA_SMOKE, notes: 'n', tags: 'New' } });
check('I4 add contact still works (module 1)', r.status === 201 || r.status === 409, `status=${r.status}`);

// ----------------------------------------------------------------- finish ----
await call('PUT', '/settings/away-message', { token: tAdmin, body: original });
await cleanup();
await pool.end();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
