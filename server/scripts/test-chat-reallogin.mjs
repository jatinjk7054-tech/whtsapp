/**
 * Reproduces the "Sign in to use Community / Your session has expired" report by
 * going through the real login endpoint instead of a hand-minted JWT.
 *
 * The earlier suite minted tokens with jsonwebtoken directly, which proves the
 * chat routes accept a well-formed token but says nothing about the token the
 * app actually holds. This drives the same flow the browser does: POST the
 * credentials, take the token the server handed back, call /api/chat with it.
 */
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const BASE = 'http://127.0.0.1:5098';
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();

let pass = 0, fail = 0;
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' -> ' + d : ''}`); }
};

async function call(t, method, path, body) {
  const opt = { method, headers: {} };
  if (t) opt.headers.Authorization = `Bearer ${t}`;
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text: text.slice(0, 200) };
}

// ---- 1. Super Admin, exactly as the browser logs in -----------------------
console.log('super admin login (env credentials)');
const login = await call(null, 'POST', '/api/auth/admin/login', {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});
console.log(`  POST /api/auth/admin/login -> ${login.status}`);
if (login.status !== 200) {
  console.log(`  body: ${login.text}`);
  console.log('  cannot continue without a token');
  await c.end();
  process.exit(1);
}
const saToken = login.json.token;
check('login returned a token', !!saToken);
console.log(`  role: ${login.json.role}, user.id: ${JSON.stringify(login.json.user?.id)}`);

console.log('\nthe same token against chat');
const convs = await call(saToken, 'GET', '/api/chat/conversations');
console.log(`  GET /api/chat/conversations -> ${convs.status}`);
if (convs.status !== 200) console.log(`  body: ${convs.text}`);
check('super admin can list conversations with a real token', convs.status === 200, String(convs.status));

const roomId = convs.json?.[0]?.id;
if (roomId) {
  const msgs = await call(saToken, 'GET', `/api/chat/conversations/${roomId}/messages`);
  console.log(`  GET messages -> ${msgs.status}`);
  check('super admin can read messages', msgs.status === 200, String(msgs.status));
}

const { SUPER_ADMIN_NOTIFY_ID } = await import('../src/services/chatNotificationTypes.js');
const notif = await call(saToken, 'GET', `/api/notifications/${SUPER_ADMIN_NOTIFY_ID}`);
console.log(`  GET /api/notifications/<sa uuid> -> ${notif.status}`);
check('the drawer endpoint accepts the same token', notif.status === 200, `${notif.status} ${notif.text}`);

// '0' is not a uuid, so the old call was a 500 rather than a 403. The client no
// longer sends it, but a bad path should not be a server error either.
const bad = await call(saToken, 'GET', '/api/notifications/0');
check('the old /notifications/0 is no longer a 500', bad.status !== 500, `${bad.status}`);

// ---- 2. What does the token actually contain? ------------------------------
console.log('\ntoken contents vs what chat needs');
const payload = JSON.parse(Buffer.from(saToken.split('.')[1], 'base64').toString());
console.log('  payload:', JSON.stringify(payload));
check('token carries an email (chatUidFor needs it for super admin)', !!payload.email);
check('token id is 0 for super admin', payload.id === 0, String(payload.id));

// ---- 3. A worker login, the other shape ------------------------------------
console.log('\nworker login (login_id + department, no email)');
const w = await c.query(
  `SELECT id, name, department, login_id, is_active FROM workers
    WHERE COALESCE(is_active, true) = true AND login_id IS NOT NULL
      AND btrim(lower(department)) IN ('admin','hr','ngo admin','digital')
   ORDER BY created_at LIMIT 1`
);
const worker = w.rows[0];
if (!worker) {
  console.log('  skip: no usable worker row');
} else {
  const role =
    worker.department.toLowerCase() === 'admin' ? 'accounts'
    : worker.department.toLowerCase() === 'hr' ? 'hr'
    : worker.department.toLowerCase() === 'ngo admin' ? 'admin'
    : 'digital';
  console.log(`  trying ${worker.login_id} (${worker.department} -> ${role})`);
  const wl = await call(null, 'POST', '/api/auth/login', {
    email: worker.login_id,
    password: 'wrong-password-on-purpose',
  });
  console.log(`  POST login -> ${wl.status} (${wl.json?.message || ''})`);
  check('a bad password is rejected, not 500', wl.status >= 400 && wl.status < 500, String(wl.status));

  // Mint exactly what the worker flow would mint, to prove chat accepts it.
  const jwt = (await import('jsonwebtoken')).default;
  const workerToken = jwt.sign(
    { id: worker.id, login_id: worker.login_id, ngo_id: worker.ngo_id, name: worker.name, role, department: worker.department },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
  const wc = await call(workerToken, 'GET', '/api/chat/conversations');
  check('worker-shaped token (no email) is accepted by chat', wc.status === 200, `${wc.status} ${wc.text}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await c.end();
process.exit(fail ? 1 : 0);
