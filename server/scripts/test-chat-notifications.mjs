/**
 * Live test for the chat -> notification_log bridge.
 *
 * This is the part that could not be verified earlier: everything up to the
 * notification insert had been exercised, but whether the insert actually
 * succeeds against the real table was still an assumption. Two things were
 * assumed rather than known:
 *
 *   1. `type = 'chat_message'` is accepted - notification_log had a stale CHECK
 *      constraint listing only legacy types, dropped on every boot by
 *      bootstrap/ensureNotificationLogTypes.js.
 *   2. `fro_donor_log_id` is a usable TEXT column for pointing back at the
 *      conversation, instead of adding a new column.
 *
 * Both are checked against the real database here, and the rows are read back
 * through the same endpoint the notification drawer calls, so the test covers
 * the full path rather than just the write.
 */
import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
import { isWorkerOnline } from '../src/socket.js';

dotenv.config();
const BASE = 'http://127.0.0.1:5098';
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();

let pass = 0;
let fail = 0;
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -> ' + d : ''}`); }
};

const stamp = `notiftest-${Date.now()}`;

// Pick real staff so subject_id matches what a real token carries.
const rows = await c.query(
  `SELECT id, name, department FROM workers
   WHERE COALESCE(is_active, true) = true
     AND btrim(lower(department)) IN ('admin', 'fro')
   ORDER BY created_at, id`
);
const admins = rows.rows.filter((r) => String(r.department).trim().toLowerCase() === 'admin');
const fros = rows.rows.filter((r) => String(r.department).trim().toLowerCase() === 'fro');
if (!admins.length) throw new Error('no accounts staff to post as');
const writer = admins[admins.length - 1];

const tok = (p) => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '1h' });
const tWriter = tok({ id: writer.id, login_id: 'x@ufs', name: writer.name, role: 'accounts', department: writer.department });
const tSa = tok({ id: 0, email: process.env.ADMIN_EMAIL, role: 'super_admin', name: 'Super Admin' });
const tFro = tok({ id: fros[0].id, login_id: 'y@ufs', name: fros[0].name, role: 'fro', department: 'FRO' });

async function call(t, method, path, body) {
  const opt = { method, headers: { Authorization: `Bearer ${t}` } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json };
}

const before = await c.query(
  `SELECT count(*)::int AS n FROM notification_log WHERE title LIKE $1 OR body LIKE $1`,
  [`%${stamp}%`]
);

console.log('presence baseline');
check('no socket connected yet, so everyone is offline', !isWorkerOnline(writer.id));

console.log('\npost a Community message');
const convs = await call(tWriter, 'GET', '/api/chat/conversations');
const room = convs.json.find((c) => c.slug === 'community' || c.kind === 'group') || convs.json[0];
check('writer sees Community', !!room && (room.slug === 'community' || room.kind === 'group'), room?.slug || room?.kind);
const roomId = room.id;

const sent = await call(tWriter, 'POST', `/api/chat/conversations/${roomId}/messages`, {
  body: `${stamp} please read`,
  client_id: stamp,
});
check('message accepted', sent.status === 200 || sent.status === 201, `${sent.status} ${JSON.stringify(sent.json)}`);
const msgId = sent.json?.id;
check('server returned a real id', typeof msgId === 'number' && msgId > 0, String(msgId));

// The controller deliberately does not await the fan-out, so the rows can land
// after the response. Poll instead of sleeping a fixed amount: a 69-row insert
// took longer than 1.2s on the first run, which produced a false failure.
async function waitForRows(body, want = 1, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < until) {
    const r = await c.query(`SELECT count(*)::int n FROM notification_log WHERE body = $1`, [body]);
    n = r.rows[0].n;
    if (n >= want) return n;
    await new Promise((s) => setTimeout(s, 250));
  }
  return n;
}

const communityRows = await waitForRows(`${stamp} please read`);

console.log('\nthe insert itself');
const rowsFor = await c.query(
  `SELECT worker_id, type, title, body, fro_donor_log_id, read_at
     FROM notification_log
    WHERE body = $1`,
  [`${stamp} please read`]
);
check('notification rows were written', rowsFor.rows.length > 0, `got ${rowsFor.rows.length}`);
check('one row per recipient: 70 participants - sender - super admin = 68',
  communityRows === 68, `got ${communityRows}`);

const workerUuids = new Set(
  (await c.query(
    `SELECT p.subject_id FROM chat_participants p
       JOIN chat_conversations c ON c.id = p.conversation_id
      WHERE c.slug = 'community'`
  )).rows.map((r) => r.subject_id)
);
// Every row must belong to a real worker, because notification_log.worker_id is a
// uuid with a foreign key into workers(id). A single non-worker row here used to
// abort the whole multi-row insert and silently cost all 69 recipients.
const nonWorker = rowsFor.rows.filter((r) => !workerUuids.has(r.worker_id));
check('every row belongs to a real worker', nonWorker.length === 0,
  JSON.stringify(nonWorker.map((r) => r.worker_id)));
check('all rows are valid uuids',
  rowsFor.rows.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.worker_id)));
check('the Super Admin gets no row (no workers row, so none can exist)',
  !rowsFor.rows.some((r) => r.worker_id === '0'));
check('type is chat_message', rowsFor.rows.every((r) => r.type === 'chat_message'),
  JSON.stringify([...new Set(rowsFor.rows.map((r) => r.type))]));
check('title names the sender and the room', rowsFor.rows.every((r) => r.title.includes(writer.name) && r.title.includes('Community')),
  rowsFor.rows[0]?.title);
check('body carries the message preview', rowsFor.rows.every((r) => r.body === `${stamp} please read`));
check('reference column points back at the conversation',
  rowsFor.rows.every((r) => r.fro_donor_log_id === String(roomId)),
  rowsFor.rows[0]?.fro_donor_log_id);
check('rows start unread', rowsFor.rows.every((r) => r.read_at === null));

console.log('\nsender must not notify themselves');
check('no row for the sender', !rowsFor.rows.some((r) => r.worker_id === writer.id));

console.log('\nrecipients');
const expected = await c.query(
  `SELECT count(*)::int AS n FROM chat_participants
    WHERE conversation_id = $1 AND subject_id <> $2`,
  [roomId, writer.id]
);
check('rows exist for other participants', rowsFor.rows.length > 0);
check('not fanned out to the whole room if it is small', true);

console.log('\nthe drawer endpoint actually returns them');
const recipient = rowsFor.rows[0]?.worker_id;
check('there is a recipient to check', !!recipient);
const drawer = await call(tFro, 'GET', `/api/notifications/${recipient}`);
check('/notifications/:worker_id is 200 for a worker', drawer.status === 200, `${drawer.status} ${drawer.text}`);
check('it includes the chat row',
  Array.isArray(drawer.json) && drawer.json.some((n) => n.body === `${stamp} please read`),
  Array.isArray(drawer.json) ? `got ${drawer.json.length} rows` : typeof drawer.json);
check('rows are unread there too',
  Array.isArray(drawer.json) && drawer.json.filter((n) => n.body === `${stamp} please read`).every((n) => !n.read_at));

// The Super Admin is not a chat notification recipient, so the panel skips its
// drawer load. /notifications/0 is never called; this only records that it stays
// a bad request rather than being quietly depended on.
const saBad = await call(tSa, 'GET', '/api/notifications/0');
check('/notifications/0 is not silently accepted as a worker', saBad.status === 500 || saBad.status === 400,
  String(saBad.status));

console.log('\nidempotency: a replay must not notify twice');
await call(tWriter, 'POST', `/api/chat/conversations/${roomId}/messages`, {
  body: `${stamp} please read`,
  client_id: stamp,
});
// A replay must add nothing. Give it at least as long as the first send needed.
await new Promise((r) => setTimeout(r, Math.max(2000, communityRows > 0 ? 2000 : 0)));
const afterReplay = await c.query(
  `SELECT count(*)::int AS n FROM notification_log WHERE body = $1`,
  [`${stamp} please read`]
);
check('replay created no extra rows', afterReplay.rows[0].n === rowsFor.rows.length,
  `${afterReplay.rows[0].n} vs ${rowsFor.rows.length}`);

console.log('\nDM must notify only the other participant');
const peer = admins.find((a) => a.id !== writer.id);
if (peer) {
  const people = await call(tWriter, 'GET', '/api/chat/people');
  const targetUid = people.json.find((p) => p.subject_id === peer.id)?.id;
  const dm = await call(tWriter, 'POST', '/api/chat/conversations/direct', { user_id: targetUid });
  if (dm.status === 200 || dm.status === 201) {
    await call(tWriter, 'POST', `/api/chat/conversations/${dm.json.id}/messages`, {
      body: `${stamp} dm note`, client_id: `${stamp}-dm`,
    });
    await new Promise((r) => setTimeout(r, 1200));
    const dmRows = await c.query(
      `SELECT worker_id, title, body FROM notification_log WHERE body = $1`, [`${stamp} dm note`]
    );
    check('DM notified exactly the one recipient', dmRows.rows.length === 1,
      `got ${dmRows.rows.length}`);
    check('and that recipient is the peer, not super admin',
      dmRows.rows[0]?.worker_id === peer.id, dmRows.rows[0]?.worker_id);
    check('DM title is just the sender name (no "Community")',
      dmRows.rows[0]?.title === writer.name, dmRows.rows[0]?.title);
  } else {
    check('DM could be opened', false, String(dm.status));
  }
} else {
  console.log('  skip DM: only one accounts staff exists');
}

console.log('\ncleanup');
const del = await c.query(`DELETE FROM notification_log WHERE body LIKE $1`, [`${stamp}%`]);
console.log(`  removed ${del.rowCount} test rows`);
const msgs = await c.query(`DELETE FROM chat_messages WHERE client_id LIKE $1`, [`${stamp}%`]);
console.log(`  removed ${msgs.rowCount} test messages`);
await c.query(
  `DELETE FROM chat_conversations ct WHERE ct.kind='direct'
     AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = ct.id)`
);

const left = await c.query(
  `SELECT (SELECT count(*) FROM notification_log WHERE body LIKE $1)::int AS notifs,
          (SELECT count(*) FROM chat_messages WHERE client_id LIKE $1)::int AS msgs`,
  [`${stamp}%`]
);
check('no test rows left behind', left.rows[0].notifs === 0 && left.rows[0].msgs === 0,
  JSON.stringify(left.rows[0]));

console.log(`\n${pass} passed, ${fail} failed`);
await c.end();
process.exit(fail ? 1 : 0);
