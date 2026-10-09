/**
 * Module 10 — Notifications & Follow-up Reminders.
 *
 *   node test-module10.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder). Meta's REST
 * API is stubbed so the inbound path is exercised end-to-end (a customer
 * message really creates a notification through the production code), while
 * everything else is driven through the HTTP API with real staff tokens.
 *
 * The suite asserts the permission model explicitly: an agent can only set and
 * see reminders/notifications tied to their own conversations. It never asserts
 * any new agent-assignment behaviour — Module 10 deliberately adds none — and
 * every fixture it creates is removed before it exits.
 */
process.env.WHATSAPP_PHONE_NUMBER_ID ||= 'M10-TEST-PHONE';
process.env.WHATSAPP_ACCESS_TOKEN ||= 'M10-TEST-TOKEN';
process.env.WHATSAPP_AUTO_REPLY_ENABLED ||= 'false';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes('graph.facebook.com')) {
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.M10-STUB-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return originalFetch(input, init);
};

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { ingestWebhookPayload } = await import('./src/conversations/inbound.service.js');
const { ensureRemindersSchema } = await import('./src/reminders/reminder.repository.js');
const { ensureNotificationsSchema, insertNotifications } = await import('./src/notifications/notification.repository.js');
const { notifyInboundMessage } = await import('./src/notifications/notification.service.js');

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
function inboundPayload(waId, text, { name = 'M10 Customer', id = null } = {}) {
  const wamid = id ?? `wamid.M10-${Date.now()}-${(wamidSeq += 1)}`;
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name } }],
      messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

/* --------------------------------------------------------------- fixtures -- */
const WA = {
  ASSIGNED1: '919876920101',
  ASSIGNED2: '919876920102',
  UNASSIGNED: '919876920103',
  EMPTY: '919876920104',
  SEARCH: '919876920105',
};
const FIXTURES = Object.values(WA);

async function seedConversation(waId, name, assignedStaffId = null) {
  const contactId = (await query(
    'INSERT INTO contacts (wa_id, name) VALUES ($1, $2) RETURNING id',
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
    await query('DELETE FROM notifications WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM reminders WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
  }
  await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
}

async function cleanup() {
  for (const wa of FIXTURES) await cleanupConversation(wa);
}

const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

/* ------------------------------------------------------------------ setup -- */
await cleanup();
await ensureRemindersSchema();
await ensureNotificationsSchema();

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
const adminRow = (await query(`SELECT id FROM staff WHERE email = 'admin@example.com'`)).rows[0];
const a1Row = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0];
const a2Row = (await query(`SELECT id FROM staff WHERE email = 'agent2@example.com'`)).rows[0];
check('S1 tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

const c1 = await seedConversation(WA.ASSIGNED1, 'M10 Alpha', a1Row.id);
const c2 = await seedConversation(WA.ASSIGNED2, 'M10 Bravo', a2Row.id);
const c3 = await seedConversation(WA.UNASSIGNED, 'M10 Charlie', null);

/* ------------------------------------------------------------ permissions -- */
let r = await call('GET', '/reminders');
check('P1 reminders without a token -> 401', r.status === 401, `status=${r.status}`);
r = await call('POST', '/reminders', { body: { conversationId: c1.convId, title: 'x', dueAt: isoIn(3600000) } });
check('P2 create reminder without a token -> 401', r.status === 401, `status=${r.status}`);
r = await call('GET', '/notifications');
check('P3 notifications without a token -> 401', r.status === 401, `status=${r.status}`);

/* --------------------------------------------------------- reminder create -- */
r = await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: c1.convId, title: 'Call back about pricing', notes: 'Ask for budget', dueAt: isoIn(3600000) },
});
const remOwn = r.json?.id;
check('R1 agent creates a reminder on their own conversation -> 201',
  r.status === 201 && Boolean(remOwn) && r.json.status === 'pending', `status=${r.status}`);

r = await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: c2.convId, title: 'Nope', dueAt: isoIn(3600000) },
});
check('R2 agent cannot create on another agent\'s conversation -> 403', r.status === 403, `status=${r.status}`);

r = await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: c3.convId, title: 'Nope', dueAt: isoIn(3600000) },
});
check('R3 agent cannot create on an unassigned conversation -> 403', r.status === 403, `status=${r.status}`);

r = await call('POST', '/reminders', {
  token: tAdmin,
  body: { conversationId: c3.convId, title: 'Admin follow-up', dueAt: isoIn(7200000) },
});
const remAdminUnassigned = r.json?.id;
check('R4 admin creates on an unassigned conversation -> 201', r.status === 201 && Boolean(remAdminUnassigned));

r = await call('POST', '/reminders', {
  token: tAdmin,
  body: { conversationId: c1.convId, title: '', dueAt: isoIn(3600000) },
});
check('R5 empty title -> 400', r.status === 400, `status=${r.status}`);

r = await call('POST', '/reminders', {
  token: tAdmin,
  body: { conversationId: c1.convId, title: 'Past', dueAt: isoIn(-3600000) },
});
check('R6 a clearly past due date -> 422', r.status === 422, `status=${r.status}`);

r = await call('POST', '/reminders', {
  token: tAdmin,
  body: { conversationId: 999999, title: 'Ghost', dueAt: isoIn(3600000) },
});
check('R7 unknown conversation -> 404', r.status === 404, `status=${r.status}`);

/* ---------------------------------------------------- agent2's own reminder -- */
r = await call('POST', '/reminders', {
  token: tA2,
  body: { conversationId: c2.convId, title: 'Agent2 task', dueAt: isoIn(5400000) },
});
const remA2 = r.json?.id;
check('R8 agent2 creates on their own conversation -> 201', r.status === 201 && Boolean(remA2));

/* --------------------------------------------------------------- visibility -- */
r = await call('GET', '/reminders?filter=all', { token: tA1 });
const a1Ids = (r.json?.items ?? []).map((x) => x.id);
check('V1 agent1 sees their reminder', a1Ids.includes(remOwn), `ids=${JSON.stringify(a1Ids)}`);
check('V2 agent1 does NOT see agent2\'s reminder', !a1Ids.includes(remA2));
check('V3 agent1 does NOT see the unassigned admin reminder', !a1Ids.includes(remAdminUnassigned));

r = await call('GET', '/reminders?filter=all', { token: tAdmin });
const adminIds = (r.json?.items ?? []).map((x) => x.id);
check('V4 admin sees every reminder', [remOwn, remA2, remAdminUnassigned].every((id) => adminIds.includes(id)));

r = await call('GET', `/reminders/${remA2}`, { token: tA1 });
check('V5 agent1 fetching agent2\'s reminder -> 404', r.status === 404, `status=${r.status}`);
r = await call('GET', `/reminders/${remOwn}`, { token: tAdmin });
check('V6 admin can fetch any reminder by id', r.status === 200 && r.json?.id === remOwn);

/* ---------------------------------------------------------------- lifecycle -- */
r = await call('PATCH', `/reminders/${remOwn}`, { token: tA1, body: { title: 'Call back (renamed)', notes: 'updated' } });
check('L1 agent edits their pending reminder -> 200', r.status === 200 && r.json?.title === 'Call back (renamed)');

r = await call('PATCH', `/reminders/${remOwn}`, { token: tA1, body: { dueAt: isoIn(10800000) } });
check('L2 reschedule (new dueAt) -> 200', r.status === 200 && new Date(r.json.dueAt).getTime() > Date.now());

r = await call('POST', `/reminders/${remOwn}/complete`, { token: tA1 });
check('L3 complete -> status completed + completedAt set',
  r.status === 200 && r.json?.status === 'completed' && Boolean(r.json?.completedAt), `status=${r.json?.status}`);

r = await call('PATCH', `/reminders/${remOwn}`, { token: tA1, body: { title: 'too late' } });
check('L4 editing a completed reminder -> 409', r.status === 409, `status=${r.status}`);

r = await call('POST', `/reminders/${remOwn}/reopen`, { token: tA1 });
check('L5 reopen -> status pending', r.status === 200 && r.json?.status === 'pending' && r.json?.completedAt === null);

r = await call('POST', `/reminders/${remOwn}/cancel`, { token: tA1 });
check('L6 cancel -> status cancelled', r.status === 200 && r.json?.status === 'cancelled');

r = await call('POST', `/reminders/${remOwn}/reopen`, { token: tA1 });
check('L7 reopen a cancelled reminder -> pending', r.json?.status === 'pending');

r = await call('POST', `/reminders/${remA2}/complete`, { token: tA1 });
check('L8 agent cannot complete another agent\'s reminder -> 404', r.status === 404, `status=${r.status}`);

/* ----------------------------------------------------------------- filters -- */
// A reminder an instant in the past is accepted (clock tolerance) and reads as
// overdue; a future one for today; a much later one as upcoming.
r = await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: c1.convId, title: 'Overdue probe', dueAt: new Date(Date.now() - 60000).toISOString() },
});
const remOverdue = r.json?.id;
check('F1 a just-past due date is accepted and flagged overdue',
  r.status === 201 && r.json?.isOverdue === true, `isOverdue=${r.json?.isOverdue}`);

const remUpcoming = (await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: c1.convId, title: 'Upcoming probe', dueAt: isoIn(6 * 86400000) },
})).json?.id;

r = await call('GET', '/reminders?filter=overdue', { token: tA1 });
check('F2 filter=overdue returns the overdue probe',
  r.status === 200 && (r.json.items ?? []).some((x) => x.id === remOverdue) &&
  (r.json.items ?? []).every((x) => x.isOverdue === true), `n=${r.json?.items?.length}`);

r = await call('GET', '/reminders?filter=due_today', { token: tA1 });
check('F3 filter=due_today returns a reminder due later today',
  r.status === 200 && (r.json.items ?? []).some((x) => x.id === remOwn), `n=${r.json?.items?.length}`);

r = await call('GET', '/reminders?filter=upcoming', { token: tA1 });
check('F4 filter=upcoming returns the far-future reminder',
  (r.json.items ?? []).some((x) => x.id === remUpcoming) && (r.json.items ?? []).every((x) => !x.isOverdue));

r = await call('GET', '/reminders?filter=completed', { token: tA2 });
check('F5 filter=completed returns only completed', r.status === 200 && (r.json.items ?? []).every((x) => x.status === 'completed'));

r = await call('GET', '/reminders', { token: tA1 });
const counts = r.json?.counts ?? {};
check('F6 counts object is present and numeric',
  typeof counts.overdue === 'number' && typeof counts.upcoming === 'number' &&
  typeof counts.dueToday === 'number' && typeof counts.all === 'number' &&
  counts.overdue >= 1 && counts.upcoming >= 1, JSON.stringify(counts));

/* ----------------------------------------------------------------- search -- */
await seedConversation(WA.SEARCH, 'Searchable Customer', a1Row.id);
const searchConv = await conversationRow(WA.SEARCH);
await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: searchConv.id, title: 'Search me', dueAt: isoIn(86400000) },
});
r = await call('GET', `/reminders?search=${encodeURIComponent('Searchable')}`, { token: tA1 });
check('F7 search by customer name finds the reminder',
  r.status === 200 && (r.json.items ?? []).some((x) => x.conversation?.contactName === 'Searchable Customer'),
  `n=${r.json?.items?.length}`);
r = await call('GET', `/reminders?search=${encodeURIComponent(WA.SEARCH)}`, { token: tA1 });
check('F8 search by customer number finds the reminder', (r.json.items ?? []).length >= 1);

/* ------------------------------------------------------------- pagination -- */
r = await call('GET', '/reminders?limit=1&offset=0', { token: tA1 });
const page1 = (r.json?.items ?? []).map((x) => x.id);
r = await call('GET', '/reminders?limit=1&offset=1', { token: tA1 });
const page2 = (r.json?.items ?? []).map((x) => x.id);
check('F9 pagination returns distinct pages',
  page1.length === 1 && page2.length === 1 && page1[0] !== page2[0], `${JSON.stringify(page1)} / ${JSON.stringify(page2)}`);

/* ------------------------------------------------- conversation reminders -- */
r = await call('GET', `/reminders?conversationId=${c1.convId}`, { token: tA1 });
check('F10 conversationId filter scopes to one thread',
  r.status === 200 && (r.json.items ?? []).every((x) => x.conversationId === c1.convId));

/* -------------------------------------------------------- new-message bell -- */
await ingestWebhookPayload(inboundPayload(WA.ASSIGNED1, 'Hi, are you there?', { name: 'M10 Alpha' }));
let notifs = (await call('GET', '/notifications', { token: tA1 })).json;
check('N1 an inbound message notifies the conversation owner',
  (notifs.items ?? []).some((n) => n.type === 'new_message' && n.title === 'M10 Alpha'),
  `unread=${notifs.unread}`);

let a2Notifs = (await call('GET', '/notifications', { token: tA2 })).json;
check('N2 another agent is not notified about someone else\'s conversation',
  !(a2Notifs.items ?? []).some((n) => n.type === 'new_message' && n.title === 'M10 Alpha'));

let adminNotifs = (await call('GET', '/notifications', { token: tAdmin })).json;
check('N3 an assigned conversation does not notify the admin',
  !(adminNotifs.items ?? []).some((n) => n.type === 'new_message' && n.title === 'M10 Alpha'));

await ingestWebhookPayload(inboundPayload(WA.UNASSIGNED, 'Anyone?', { name: 'M10 Charlie' }));
adminNotifs = (await call('GET', '/notifications', { token: tAdmin })).json;
check('N4 an unassigned conversation notifies the admins',
  (adminNotifs.items ?? []).some((n) => n.type === 'new_message' && n.title === 'M10 Charlie'));

/* ------------------------------------------------------------- dedupe -- */
const convRow = await conversationRow(WA.ASSIGNED1);
const before = (await query(
  "SELECT COUNT(*)::int AS n FROM notifications WHERE dedupe_key = 'new_message:424242'"
)).rows[0].n;
await notifyInboundMessage(
  { id: convRow.id, assigned_staff_id: convRow.assigned_staff_id, contact_name: convRow.contact_name, contact_wa_id: convRow.contact_wa_id },
  { id: 424242, body: 'dup', type: 'text' }
);
await notifyInboundMessage(
  { id: convRow.id, assigned_staff_id: convRow.assigned_staff_id, contact_name: convRow.contact_name, contact_wa_id: convRow.contact_wa_id },
  { id: 424242, body: 'dup', type: 'text' }
);
const after = (await query(
  "SELECT COUNT(*)::int AS n FROM notifications WHERE dedupe_key = 'new_message:424242'"
)).rows[0].n;
check('N5 the same message never creates a duplicate notification', before === 0 && after === 1, `after=${after}`);

const sweepDup = await insertNotifications([
  { staffId: a1Row.id, type: 'reminder_due', conversationId: convRow.id, reminderId: null, title: 'x', body: 'y', dedupeKey: 'sweep:test' },
  { staffId: a1Row.id, type: 'reminder_due', conversationId: convRow.id, reminderId: null, title: 'x', body: 'y', dedupeKey: 'sweep:test' },
]);
check('N6 insertNotifications is de-duplicated within one call', sweepDup === 1, `created=${sweepDup}`);

/* --------------------------------------------------------- due sweep -- */
r = await call('POST', '/reminders', {
  token: tA1,
  body: { conversationId: c1.convId, title: 'Due sweep probe', dueAt: new Date(Date.now() - 45000).toISOString() },
});
const remSweep = r.json?.id;
notifs = (await call('GET', '/notifications?unreadOnly=true', { token: tA1 })).json;
check('N7 listing notifications sweeps a due reminder into a reminder_due alert',
  (notifs.items ?? []).some((n) => n.type === 'reminder_due' && n.reminderId === remSweep),
  `ids=${JSON.stringify((notifs.items ?? []).map((n) => [n.type, n.reminderId]))}`);

/* ------------------------------------------------------------ read state -- */
notifs = (await call('GET', '/notifications', { token: tA1 })).json;
const firstUnread = (notifs.items ?? []).find((n) => !n.isRead);
const unreadBefore = notifs.unread;
r = await call('POST', `/notifications/${firstUnread.id}/read`, { token: tA1 });
notifs = (await call('GET', '/notifications', { token: tA1 })).json;
check('N8 marking one read lowers the unread count by one',
  r.status === 200 && notifs.unread === unreadBefore - 1, `before=${unreadBefore} after=${notifs.unread}`);

// Isolation: agent2 cannot mark agent1's (still unread) notification read.
const victim = (notifs.items ?? []).find((n) => !n.isRead);
r = await call('POST', `/notifications/${victim.id}/read`, { token: tA2 });
const stillUnread = (await query(
  'SELECT read_at FROM notifications WHERE id = $1', [victim.id]
)).rows[0];
check('N9 another staff member cannot mark your notification read',
  r.status === 200 && stillUnread?.read_at === null, `read_at=${stillUnread?.read_at}`);

r = await call('POST', '/notifications/read-all', { token: tA1 });
notifs = (await call('GET', '/notifications', { token: tA1 })).json;
check('N10 read-all clears the unread count', r.status === 200 && notifs.unread === 0, `unread=${notifs.unread}`);

/* -------------------------------------------------------------- isolation -- */
const alpha = (await call('GET', '/notifications', { token: tA1 })).json.items ?? [];
const charlieLeak = alpha.some((n) => n.title === 'M10 Charlie');
check('N11 an agent never receives the admins\' unassigned notifications', !charlieLeak);

/* ---------------------------------------------------------------- restore -- */
await cleanup();

await pool.end();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log(failed.map((entry) => `  FAILED: ${entry.name}`).join('\n'));
  process.exitCode = 1;
}
