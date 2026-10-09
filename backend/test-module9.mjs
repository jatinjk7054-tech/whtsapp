/**
 * Module 9 — Advanced WhatsApp Automation.
 *
 *   node test-module9.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder). Meta's REST
 * API is stubbed exactly like modules 6/7/8, so every keyword reply really goes
 * through the production send path (`sendTextMessage` / `sendTemplateMessage`)
 * without ever contacting WhatsApp. The suite also exercises the engines
 * directly (matching, the 24-hour policy, holidays) so the pure decision code is
 * covered even when no HTTP round-trip is involved.
 *
 * It never asserts an automatic agency-assignment behaviour exists: Module 9
 * deliberately adds none. All fixtures are created and removed by the run.
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M9-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M9-TEST-TOKEN';
process.env.WHATSAPP_AUTO_REPLY_ENABLED ||= 'false';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.M9-STUB-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return originalFetch(input, init);
};

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { ingestWebhookPayload } = await import('./src/conversations/inbound.service.js');
const { ensureAutomationSchema } = await import('./src/automation/automation.repository.js');
const { runAutomationForInbound } = await import('./src/automation/automation.service.js');
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

let wamidSeq = 0;
function inboundPayload(waId, text, { name = 'M9 Customer', id = null } = {}) {
  const wamid = id ?? `wamid.M9-${Date.now()}-${(wamidSeq += 1)}`;
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name } }],
      messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

/* --------------------------------------------------------------- fixtures -- */
const WA = {
  K1: '919876900101',
  K2: '919876900102',
  K3A: '919876900103',
  K3B: '919876900104',
  K4: '919876900105',
  K5: '919876900106',
  K6A: '919876900107',
  K6B: '919876900108',
};
const FIXTURES = Object.values(WA);

const createdRules = [];
// Conversations seeded directly with an owner (to test the 24h policy) are not
// automation output; N1 excludes them so it only checks automation's own effect.
const seededConversations = [];

async function cleanupConversation(wa) {
  const convs = (await query(
    `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`,
    [wa]
  )).rows.map((row) => row.id);

  if (convs.length) {
    await query('DELETE FROM automation_logs WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM automation_rule_state WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
  }
  await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
}

async function cleanup() {
  for (const wa of FIXTURES) await cleanupConversation(wa);
  if (createdRules.length) {
    await query('DELETE FROM automation_rules WHERE id = ANY($1::int[])', [createdRules]);
    createdRules.length = 0;
  }
}

async function seedOldConversation(waId, name, body, whenIso, assignedStaffId = null) {
  const contactId = (await query(
    'INSERT INTO contacts (wa_id, name) VALUES ($1, $2) RETURNING id',
    [waId, name]
  )).rows[0].id;
  const convId = (await query(
    `INSERT INTO conversations (contact_id, assigned_staff_id, status, last_message_at, created_at, updated_at)
     VALUES ($1, $2, 'open', $3, $3, $3) RETURNING id`,
    [contactId, assignedStaffId, whenIso]
  )).rows[0].id;
  const messageId = (await query(
    `INSERT INTO messages (conversation_id, direction, status, type, body, created_at, wa_message_id)
     VALUES ($1, 'inbound', 'received', 'text', $2, $3, $4) RETURNING id`,
    [convId, body, whenIso, `wamid.M9.SEED-${waId}`]
  )).rows[0].id;
  if (assignedStaffId) seededConversations.push(convId);
  return { contactId, convId, messageId };
}

async function conversationFor(waId) {
  return (await query(
    `SELECT c.id AS conversation_id, c.contact_id, ct.wa_id AS contact_wa_id
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.wa_id = $1 ORDER BY c.id DESC LIMIT 1`,
    [waId]
  )).rows[0];
}

async function outboundFor(conversationId) {
  return (await query(
    `SELECT id, type, body, status, sent_by_staff_id, template_name
       FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY id`,
    [conversationId]
  )).rows;
}

async function lastLog(conversationId) {
  return (await query(
    `SELECT action, result, rule_name, detail FROM automation_logs
      WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
    [conversationId]
  )).rows[0] ?? null;
}

async function createRule(token, body) {
  const res = await call('POST', '/automation/rules', { token, body });
  if (res.json?.id) createdRules.push(res.json.id);
  return res;
}

/* ------------------------------------------------------------------ setup -- */
await cleanup();
await ensureAutomationSchema();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const adminRow = (await query(`SELECT id FROM staff WHERE email = 'admin@example.com'`)).rows[0];
const a1Row = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0];
check('tokens minted for admin / agent1', Boolean(tAdmin && tA1));

const awayBefore = (await call('GET', '/settings/away-message', { token: tAdmin })).json?.settings;
const autoBefore = (await call('GET', '/automation/settings', { token: tAdmin })).json?.settings;

/* ----------------------------------------------------------- permissions -- */
let r = await call('GET', '/automation/settings');
check('A1 settings without token -> 401', r.status === 401, `status=${r.status}`);
r = await call('GET', '/automation/settings', { token: tA1 });
check('A2 agent settings -> 403 (admin-only on the backend)', r.status === 403, `status=${r.status}`);
r = await call('PUT', '/automation/settings', { token: tA1, body: { enabled: true } });
check('A3 agent update -> 403', r.status === 403, `status=${r.status}`);
r = await call('GET', '/automation/rules', { token: tA1 });
check('A4 agent rules list -> 403', r.status === 403, `status=${r.status}`);
r = await call('GET', '/automation/logs', { token: tA1 });
check('A5 agent logs -> 403', r.status === 403, `status=${r.status}`);

/* -------------------------------------------------------------- settings -- */
r = await call('GET', '/automation/settings', { token: tAdmin });
check('B1 admin settings -> 200 with boolean shape',
  r.status === 200 && typeof r.json?.settings?.enabled === 'boolean' &&
  typeof r.json?.settings?.sendAwayAndKeyword === 'boolean', JSON.stringify(r.json?.settings));
r = await call('PUT', '/automation/settings', { token: tAdmin, body: { enabled: true, sendAwayAndKeyword: false } });
check('B2 enable automation -> enabled true', r.status === 200 && r.json?.settings?.enabled === true,
  JSON.stringify(r.json?.settings));
r = await call('GET', '/automation/settings', { token: tAdmin });
check('B3 read-back reflects the change', r.json?.settings?.enabled === true && r.json?.settings?.sendAwayAndKeyword === false);
r = await call('PUT', '/automation/settings', { token: tAdmin, body: {} });
check('B4 empty settings update -> 400', r.status === 400, `status=${r.status}`);

/* ----------------------------------------------------------------- rules -- */
r = await createRule(tAdmin, {
  name: 'M9 Donate', keyword: 'donate', matchType: 'contains',
  replyText: 'THANKS_FOR_DONATE', enabled: true, priority: 5, cooldownSeconds: 0,
});
const donateRuleId = r.json?.id;
check('C1 create rule (contains) -> 201', r.status === 201 && Boolean(donateRuleId), `status=${r.status}`);

r = await createRule(tAdmin, {
  name: 'M9 Donate', keyword: 'other', matchType: 'contains', replyText: 'x', enabled: true,
});
check('C2 duplicate name (case-insensitive) -> 409', r.status === 409, `status=${r.status}`);

r = await call('POST', '/automation/rules', { token: tAdmin, body: { name: 'M9 No Reply', keyword: 'a', matchType: 'contains' } });
check('C3 missing reply text -> 400', r.status === 400, `status=${r.status}`);

r = await call('POST', '/automation/rules', {
  token: tAdmin,
  body: { name: 'M9 Bad Tag', keyword: 'b', matchType: 'contains', replyText: 'x', tagId: 999999 },
});
check('C4 unknown tag -> 422', r.status === 422, `status=${r.status}`);

r = await call('POST', '/automation/rules', {
  token: tAdmin,
  body: { name: 'M9 Template Pair', keyword: 'c', matchType: 'contains', replyText: 'x', templateName: 'only_name' },
});
check('C5 template name without language -> 400', r.status === 400, `status=${r.status}`);

r = await call('PUT', '/automation/settings', { token: tAdmin, body: { enabled: true } });
r = await call('PATCH', `/automation/rules/${donateRuleId}`, { token: tAdmin, body: { priority: 7 } });
check('C6 patch rule priority -> 200', r.status === 200 && r.json?.priority === 7, `status=${r.status} p=${r.json?.priority}`);
r = await call('PATCH', '/automation/rules/999999', { token: tAdmin, body: { priority: 1 } });
check('C7 patch missing rule -> 404', r.status === 404, `status=${r.status}`);
r = await call('GET', '/automation/rules', { token: tAdmin });
check('C8 rules list includes the created rule', r.status === 200 && r.json?.items?.some((rule) => rule.id === donateRuleId));

/* ----------------------------------------------------------- match engine -- */
async function match(text, keyword, matchType) {
  const body = { text };
  if (keyword != null) body.keyword = keyword;
  if (matchType != null) body.matchType = matchType;
  const res = await call('POST', '/automation/test', { token: tAdmin, body });
  return res.json?.matched;
}

check('D1 contains: "donate" in "I want to donate now"', (await match('I want to donate now', 'donate', 'contains')) === true);
check('D2 exact: "donate" !== "please donate"', (await match('please donate', 'donate', 'exact')) === false);
check('D3 exact: "donate" === "donate" (case-insensitive)', (await match('DoNaTe', 'donate', 'exact')) === true);
check('D4 starts_with: "hi there" starts with "hi"', (await match('hi there', 'hi', 'starts_with')) === true);
check('D5 ends_with: "ok bye" ends with "bye"', (await match('ok bye', 'bye', 'ends_with')) === true);
check('D6 whole_word: "gifting" does NOT match "gift"', (await match('this is gifting', 'gift', 'whole_word')) === false);
check('D7 whole_word: "a gift for you" matches "gift"', (await match('a gift for you', 'gift', 'whole_word')) === true);
check('D8 saved rule matches via /test', (await match('I want to donate', null, null)) === true);
check('D9 no match -> matched false', (await match('completely unrelated', null, null)) === false);

/* -------------------------------------------------- end-to-end: keyword -- */
await call('PUT', '/settings/away-message', { token: tAdmin, body: { ...awayBefore, enabled: false } });

await ingestWebhookPayload(inboundPayload(WA.K1, 'I want to donate today'));
let conv = await conversationFor(WA.K1);
let outs = await outboundFor(conv.conversation_id);
const k1Reply = outs.find((m) => m.body === 'THANKS_FOR_DONATE');
check('E1 keyword reply sent (outbound, no staff sender, status sent)',
  Boolean(k1Reply) && k1Reply.sent_by_staff_id === null && k1Reply.status === 'sent' && k1Reply.type === 'text',
  JSON.stringify(k1Reply));
let log = await lastLog(conv.conversation_id);
check('E2 automation log records the sent keyword reply',
  log?.action === 'keyword_reply' && log?.result === 'sent' && log?.rule_name === 'M9 Donate', JSON.stringify(log));

/* -------------------------------------------------------------- cooldown -- */
r = await createRule(tAdmin, {
  name: 'M9 Cooldown', keyword: 'coolword', matchType: 'contains',
  replyText: 'COOLDOWN_REPLY', enabled: true, cooldownSeconds: 3600,
});
await ingestWebhookPayload(inboundPayload(WA.K2, 'coolword first'));
conv = await conversationFor(WA.K2);
outs = await outboundFor(conv.conversation_id);
check('F1 cooldown rule replies the first time', outs.filter((m) => m.body === 'COOLDOWN_REPLY').length === 1);

await ingestWebhookPayload(inboundPayload(WA.K2, 'coolword second'));
outs = await outboundFor(conv.conversation_id);
const skipped = (await query(
  `SELECT COUNT(*)::int AS n FROM automation_logs
    WHERE conversation_id = $1 AND action = 'keyword_reply' AND result = 'skipped'`,
  [conv.conversation_id]
)).rows[0].n;
check('F2 cooldown blocks the second reply and logs it as skipped',
  outs.filter((m) => m.body === 'COOLDOWN_REPLY').length === 1 && skipped >= 1, `replies=${outs.length} skipped=${skipped}`);

/* ------------------------------------------------------- duplicate (wamid) -- */
const dupPayload = inboundPayload(WA.K1, 'I want to donate now', { id: `wamid.M9.DUPLICATE.${Date.now()}` });
await ingestWebhookPayload(dupPayload);
const afterFirst = (await outboundFor((await conversationFor(WA.K1)).conversation_id))
  .filter((m) => m.body === 'THANKS_FOR_DONATE').length;
await ingestWebhookPayload(dupPayload);
const afterSecond = (await outboundFor((await conversationFor(WA.K1)).conversation_id))
  .filter((m) => m.body === 'THANKS_FOR_DONATE').length;
check('G1 a redelivered webhook never produces a second keyword reply',
  afterFirst === 2 && afterSecond === 2, `afterFirst=${afterFirst} afterSecond=${afterSecond}`);

/* ---------------------------------------------------- disabled => silent -- */
await call('PUT', '/automation/settings', { token: tAdmin, body: { enabled: false } });
await ingestWebhookPayload(inboundPayload(WA.K4, 'I want to donate please'));
conv = await conversationFor(WA.K4);
outs = await outboundFor(conv.conversation_id);
check('H1 master OFF means no keyword reply is sent',
  outs.filter((m) => m.body === 'THANKS_FOR_DONATE').length === 0, `outbound=${outs.length}`);
await call('PUT', '/automation/settings', { token: tAdmin, body: { enabled: true } });

/* ------------------------------------------------ away message + keyword -- */
const ALL_DAYS_OFF = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day, enabled: false, from: '09:00', to: '18:00',
}));
await call('PUT', '/settings/away-message', {
  token: tAdmin,
  body: { enabled: true, message: 'AWAY_MESSAGE_TEXT', timezone: 'Asia/Kolkata', schedule: ALL_DAYS_OFF, holidays: [] },
});
await call('PUT', '/automation/settings', { token: tAdmin, body: { enabled: true, sendAwayAndKeyword: false } });

await ingestWebhookPayload(inboundPayload(WA.K3A, 'I want to donate'));
conv = await conversationFor(WA.K3A);
outs = await outboundFor(conv.conversation_id);
check('I1 away message sent and keyword suppressed by default guard',
  outs.some((m) => m.body === 'AWAY_MESSAGE_TEXT') && !outs.some((m) => m.body === 'THANKS_FOR_DONATE'),
  JSON.stringify(outs.map((m) => m.body)));

await call('PUT', '/automation/settings', { token: tAdmin, body: { enabled: true, sendAwayAndKeyword: true } });
await ingestWebhookPayload(inboundPayload(WA.K3B, 'I want to donate'));
conv = await conversationFor(WA.K3B);
outs = await outboundFor(conv.conversation_id);
check('I2 with the opt-in both the away message and the keyword reply are sent',
  outs.some((m) => m.body === 'AWAY_MESSAGE_TEXT') && outs.some((m) => m.body === 'THANKS_FOR_DONATE'),
  JSON.stringify(outs.map((m) => m.body)));
check('I3 the away message is recorded in the automation log',
  (await query(
    `SELECT COUNT(*)::int AS n FROM automation_logs WHERE conversation_id = $1 AND action = 'away_message' AND result = 'sent'`,
    [conv.conversation_id]
  )).rows[0].n >= 1);

/* ------------------------------------------------- 24h policy (outbound) -- */
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
let seeded = await seedOldConversation(WA.K5, 'M9 Old Window', 'hello from before', twoDaysAgo, a1Row.id);
r = await call('POST', `/conversations/${seeded.convId}/messages`, {
  token: tA1, body: { type: 'text', body: 'replying outside the window' },
});
check('J1 free-form send outside the 24h window -> 409', r.status === 409, `status=${r.status}`);

await ingestWebhookPayload(inboundPayload(WA.K5, 'I am back'));
r = await call('POST', `/conversations/${seeded.convId}/messages`, {
  token: tA1, body: { type: 'text', body: 'replying inside the window' },
});
check('J2 the same send inside the window -> 200', r.status === 200 || r.status === 201, `status=${r.status}`);

/* -------------------------------------- 24h policy (automation fallback) -- */
r = await createRule(tAdmin, {
  name: 'M9 Blocked', keyword: 'blockword', matchType: 'contains',
  replyText: 'BLOCKED_REPLY', enabled: true, cooldownSeconds: 0,
});
const blockedRuleId = r.json?.id;
seeded = await seedOldConversation(WA.K6A, 'M9 Blocked Window', 'blockword', twoDaysAgo);
let summary = await runAutomationForInbound(
  { id: seeded.convId, contact_id: seeded.contactId, contact_wa_id: WA.K6A },
  { id: seeded.messageId, body: 'blockword' },
  { awaySent: false }
);
check('K1 out-of-window keyword with no template -> blocked', summary.result === 'blocked', JSON.stringify(summary));
log = await lastLog(seeded.convId);
check('K2 the blocked attempt is logged', log?.action === 'keyword_reply' && log?.result === 'blocked', JSON.stringify(log));

await call('PATCH', `/automation/rules/${blockedRuleId}`, {
  token: tAdmin, body: { templateName: 'm9_tmpl', templateLanguage: 'en_US' },
});
seeded = await seedOldConversation(WA.K6B, 'M9 Template Window', 'blockword', twoDaysAgo);
summary = await runAutomationForInbound(
  { id: seeded.convId, contact_id: seeded.contactId, contact_wa_id: WA.K6B },
  { id: seeded.messageId, body: 'blockword' },
  { awaySent: false }
);
conv = await conversationFor(WA.K6B);
outs = await outboundFor(conv.conversation_id);
check('K3 out-of-window keyword with an approved template -> template fallback sent',
  summary.result === 'sent' && outs.some((m) => m.type === 'template' && m.sent_by_staff_id === null),
  JSON.stringify(summary));

/* -------------------------------------------------------------- holidays -- */
const CLOSED_RANGE = '00:00';
const BUSY_RANGE = '23:59';
const allDaysOpen = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day, enabled: true, from: CLOSED_RANGE, to: BUSY_RANGE,
}));
const fixedNow = new Date('2099-06-15T06:00:00Z'); // 11:30 IST, inside 00:00–23:59
const baseSettings = {
  enabled: true, message: 'HOLIDAY_TEST', timezone: 'Asia/Kolkata', schedule: allDaysOpen, holidays: [],
};
const beforeHoliday = evaluateAwayWindow(baseSettings, fixedNow);
const holidaySettings = { ...baseSettings, holidays: [beforeHoliday.date] };
const onHoliday = evaluateAwayWindow(holidaySettings, fixedNow);
check('L1 a normal open day inside office hours does not send',
  beforeHoliday.insideOfficeHours === true && beforeHoliday.shouldSend === false, beforeHoliday.reason);
check('L2 the same moment marked as a holiday fires the Away Message',
  onHoliday.isHoliday === true && onHoliday.shouldSend === true && /holiday/i.test(onHoliday.reason),
  onHoliday.reason);

const todayInZone = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
r = await call('PUT', '/settings/away-message', {
  token: tAdmin,
  body: { enabled: true, message: 'HOLIDAY_TEST', timezone: 'Asia/Kolkata', schedule: allDaysOpen, holidays: [todayInZone] },
});
check('L3 holidays persist through the API', r.status === 200 &&
  Array.isArray(r.json?.settings?.holidays) && r.json.settings.holidays.includes(todayInZone) &&
  r.json?.evaluation?.isHoliday === true, JSON.stringify(r.json?.settings?.holidays));
r = await call('PUT', '/settings/away-message', {
  token: tAdmin,
  body: { ...awayBefore, holidays: ['2026-13-40'] },
});
check('L4 an impossible holiday date -> 400', r.status === 400, `status=${r.status}`);

/* ----------------------------------------------------------------- logs -- */
r = await call('GET', '/automation/logs?action=keyword_reply&limit=50', { token: tAdmin });
check('M1 logs endpoint returns keyword-reply entries only',
  r.status === 200 && Array.isArray(r.json?.items) &&
  r.json.items.every((entry) => entry.action === 'keyword_reply'), `status=${r.status} n=${r.json?.items?.length}`);
r = await call('GET', '/automation/logs?limit=5&offset=0', { token: tAdmin });
check('M2 logs pagination shape (items + total)', r.status === 200 && Array.isArray(r.json?.items) && typeof r.json?.total === 'number');

/* ------------------------------------------------------------ no autoassign -- */
const autoAssigned = (await query(
  `SELECT COUNT(*)::int AS n FROM conversations
    WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = ANY($1::text[]))
      AND assigned_staff_id IS NOT NULL
      AND id <> ALL($2::int[])`,
  [FIXTURES, seededConversations]
)).rows[0].n;
check('N1 automation never assigned a fixture conversation to an agent', autoAssigned === 0, `assigned=${autoAssigned}`);

/* ---------------------------------------------------------------- restore -- */
await call('PUT', '/settings/away-message', { token: tAdmin, body: awayBefore });
await call('PUT', '/automation/settings', { token: tAdmin, body: autoBefore });
await cleanup();

await pool.end();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
