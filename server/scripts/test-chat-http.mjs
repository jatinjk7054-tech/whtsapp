import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();
const BASE = 'http://127.0.0.1:5099';
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();

const cand = await c.query(
  `SELECT id, name, department FROM workers
   WHERE COALESCE(is_active, true) = true
     AND btrim(lower(department)) IN
         ('hr', 'ngo admin', 'digital', 'fro', 'event manager')
   ORDER BY btrim(lower(department)), created_at, id`
);

const admins = await c.query(
  `SELECT id, name, department FROM workers
   WHERE COALESCE(is_active, true) = true AND btrim(lower(department)) = 'admin'
   ORDER BY created_at, id`
);
if (admins.rows.length < 2) throw new Error('need 2 accounts staff to test a DM between two people');

// Map department -> the role authController.js would put in the JWT.
const roleOf = (d) => {
  const x = String(d || '').toLowerCase().trim();
  if (x === 'hr') return 'hr';
  if (x.includes('recruit')) return 'recruiter';
  if (x === 'admin') return 'accounts';
  if (x === 'fro') return 'fro';
  if (x === 'ngo admin') return 'admin';
  if (x === 'digital' || x.includes('develop')) return 'digital';
  if (x.includes('event')) return 'event_head';
  return 'worker';
};
for (const r of [...cand.rows, ...admins.rows]) r.role = roleOf(r.department);

const byRole = {};
for (const r of [...cand.rows, ...admins.rows]) if (!byRole[r.role]) byRole[r.role] = r;
console.log(
  'staff picked:',
  [...cand.rows, ...admins.rows].map((r) => `${r.name} (${r.department} -> ${r.role})`).join(', '),
  '\n'
);

const need = (role) => {
  const r = byRole[role];
  if (!r) throw new Error(`no active worker maps to role "${role}" - cannot run this suite`);
  return r;
};
const W = (r, over = {}) => ({
  id: r.id, login_id: `x@ufs`, name: r.name, role: r.role,
  department: r.department, ...over,
});
const writer = W(need('accounts'));
const peerWriterRow = admins.rows.find((r) => r.id !== writer.id);
const peerWriter = W(peerWriterRow);
const fro = W(need('fro'));
const hr = W(need('hr'));
const digitalRow = byRole.digital;
const digital = digitalRow ? W(digitalRow) : null;
const ehRow = byRole.event_head;
const eventHead = ehRow ? W(ehRow) : null;
const sa = { id: 0, email: process.env.ADMIN_EMAIL, role: 'super_admin', name: 'Super Admin' };

const tok = (p) => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '1h' });
const T = {
  sa: tok(sa), writer: tok(writer), peer: tok(peerWriter),
  fro: tok(fro), hr: tok(hr), digital: digital ? tok(digital) : null,
  eh: eventHead ? tok(eventHead) : null,
};

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -> ' + d : ''}`); }
};

async function call(t, method, path, body, isForm) {
  const opt = { method, headers: { Authorization: `Bearer ${t}` } };
  if (body && !isForm) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  else if (body) opt.body = body;
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html error page */ }
  return { status: r.status, json, text };
}

console.log('auth');
check('no token -> 401', (await call('', 'GET', '/api/chat/conversations')).status === 401);
check('garbage token -> 401', (await call('nope', 'GET', '/api/chat/conversations')).status === 401);

console.log('\ncontract: conversations');
const convs = await call(T.writer, 'GET', '/api/chat/conversations');
check('200', convs.status === 200, String(convs.status));
check('is a bare array (not wrapped)', Array.isArray(convs.json));
check('has unread_count, not unread', convs.json?.every((c) => 'unread_count' in c && !('unread' in c)));
check('last_message is null before any message', convs.json?.[0]?.last_message === null);
check('member_count present', typeof convs.json?.[0]?.member_count === 'number');

console.log('\ncontract: messages');
const roomId = convs.json[0].id;
const msgs = await call(T.writer, 'GET', `/api/chat/conversations/${roomId}/messages`);
check('200', msgs.status === 200);
check('has { messages, has_more }', Array.isArray(msgs.json?.messages) && 'has_more' in msgs.json);
check('empty room -> empty array', msgs.json?.messages?.length === 0);

console.log('\nread access');
for (const [label, t] of [['FRO', T.fro], ['HR', T.hr], ['Digital', T.digital], ['Event Head', T.eh], ['Super Admin', T.sa]]) {
  if (!t) { console.log(`  skip ${label} (no such staff row)`); continue; }
  const r = await call(t, 'GET', '/api/chat/conversations');
  check(`${label} can read Community`, r.status === 200 && r.json?.length === 1, `status ${r.status}`);
}
const unknown = await call(tok({ id: 'not-a-worker', role: 'fro' }), 'GET', `/api/chat/conversations/${roomId}/messages`);
check('a non-participant gets 404, not 403/500', unknown.status === 404, String(unknown.status));

console.log('\nwrite policy');
const ro = await call(T.fro, 'POST', `/api/chat/conversations/${roomId}/messages`, { body: 'nope' });
check('read-only role cannot post', ro.status === 403, String(ro.status));
const w = await call(T.writer, 'POST', `/api/chat/conversations/${roomId}/messages`, { body: 'e2e hello', client_id: 'e2e-1' });
check('writer can post', w.status === 200 || w.status === 201, String(w.status));
const mid = w.json?.id;
check('returns a real row id (not tmp-)', typeof mid === 'number' && mid > 0, String(mid));
check('returns the echoed client_id (reconcile key)', w.json?.client_id === 'e2e-1');
check('body round-trips', w.json?.body === 'e2e hello');

console.log('\nidempotency');
const again = await call(T.writer, 'POST', `/api/chat/conversations/${roomId}/messages`, { body: 'e2e hello', client_id: 'e2e-1' });
check('replayed client_id returns the same row, no duplicate', again.json?.id === mid, `${again.json?.id} vs ${mid}`);
const count = await c.query('SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id=$1', [roomId]);
check('exactly one row in the table', count.rows[0].n === 1, String(count.rows[0].n));

console.log('\nunread');
check('GET /unread-count is a bare number', typeof (await call(T.fro, 'GET', '/api/chat/unread-count')).json === 'number');
const froConvs = await call(T.fro, 'GET', '/api/chat/conversations');
check('sender does not count their own message as unread', froConvs.json[0].unread_count === 1, String(froConvs.json[0].unread_count));
const saConvs = await call(T.sa, 'GET', '/api/chat/conversations');
check('super admin (other person) sees it as unread', saConvs.json[0].unread_count === 1);
const mr = await call(T.fro, 'POST', `/api/chat/conversations/${roomId}/read`, { message_id: mid });
check('read-only role CAN mark read', mr.status === 200, String(mr.status));
const afterRead = await call(T.fro, 'GET', '/api/chat/unread-count');
check('unread drops to 0 after markRead', afterRead.json === 0, String(afterRead.json));

console.log('\nsearch + edit + delete');
const s = await call(T.fro, 'GET', `/api/chat/conversations/${roomId}/search?q=e2e`);
check('search returns a bare array', Array.isArray(s.json), typeof s.json);
check('search finds the message', s.json?.some((m) => m.id === mid));
const e = await call(T.writer, 'PATCH', `/api/chat/messages/${mid}`, { body: 'e2e edited' });
check('writer can edit own message', e.status === 200 && e.json?.body === 'e2e edited', String(e.status));
const eFro = await call(T.fro, 'PATCH', `/api/chat/messages/${mid}`, { body: 'hijack' });
check('a read-only role cannot edit anything', eFro.status === 403, String(eFro.status));
const d = await call(T.writer, 'DELETE', `/api/chat/messages/${mid}`);
check('writer can delete own message', d.status === 200, String(d.status));
const dSa = await call(T.sa, 'DELETE', `/api/chat/messages/${mid}`);
check('super admin CAN moderate in Community', dSa.status === 200, String(dSa.status));

console.log('\nDM: only writers, and only the two of them');
const peopleReadOnly = await call(T.fro, 'GET', '/api/chat/people');
check('read-only role is refused the people list', [403, 404].includes(peopleReadOnly.status), String(peopleReadOnly.status));
const people = await call(T.writer, 'GET', '/api/chat/people');
check('writer gets a bare array', Array.isArray(people.json));
check('targets are writer roles only', people.json?.every((p) => p.role === 'accounts'), JSON.stringify(people.json?.map((p) => p.role)));
check('caller excluded from own target list', !people.json?.some((p) => p.subject_id === writer.id));
// openDirect takes a uid, not a bare worker id: the people list exposes
// `id` as the `login:<uuid>` key that chatUidFor derives, and the controller
// looks the target up by that exact string.
const peerUid = people.json.find((p) => p.subject_id === peerWriter.id)?.id;
check('people list exposes id as a login: uid', /^login:/.test(peerUid || ''), String(peerUid));
const d1 = await call(T.writer, 'POST', '/api/chat/conversations/direct', { user_id: peerUid });
check('writer can open a DM', d1.status === 200 || d1.status === 201, String(d1.status));
check('DM is returned as a bare conversation', typeof d1.json?.id === 'number' && d1.json?.kind === 'direct');
const dmId = d1.json?.id;
const dmW = await call(T.writer, 'POST', `/api/chat/conversations/${dmId}/messages`, { body: 'dm hi' });
check('writer can post in own DM', dmW.status === 200 || dmW.status === 201, String(dmW.status));
const dmSa = await call(T.sa, 'POST', `/api/chat/conversations/${dmId}/messages`, { body: 'super admin snoop' });
check('super admin is NOT auto-added to a DM', [404, 403].includes(dmSa.status), String(dmSa.status));
const dmPeer = await call(T.peer, 'GET', `/api/chat/conversations/${dmId}/messages`);
check('the other participant can read it', dmPeer.status === 200, String(dmPeer.status));
check('peer sees the writer message', dmPeer.json?.messages?.some((m) => m.id === dmW.json?.id));

console.log(`\n${pass} passed, ${fail} failed`);
await c.end();
process.exit(fail ? 1 : 0);
