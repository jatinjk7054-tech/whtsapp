const BASE = 'http://localhost:4000/api';
const WA = '919999888777'; // fresh fake number for Module 1 tests

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

async function login(email, password) {
  const res = await fetch(`${BASE}/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.token ?? body.accessToken ?? body.session?.token;
}

// The seeded agents' passwords were changed from the config defaults at some
// point, so we mint the exact token /login would issue (same payload, same
// secret) instead of rewriting the user's passwords in the database.
const { signToken } = await import('./src/lib/jwt.js');
const { query } = await import('./src/db/pool.js');
async function tokenFor(email) {
  const r = await query('SELECT id, name, email, role FROM staff WHERE email = $1 AND is_active', [email]);
  if (!r.rows[0]) throw new Error(`no staff ${email}`);
  return signToken(r.rows[0]);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const t1 = await login('admin@example.com', 'change-me-please');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('token admin/agent1/agent2', Boolean(t1 && tA1 && tA2));

// clean slate
await query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1))', [WA]);
await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)', [WA]);
await query('DELETE FROM contacts WHERE wa_id = $1', [WA]);

// A1: save new contact with notes + tags
let r = await call('POST', '/contacts', {
  token: tA1,
  body: { name: 'Jatin Sharma', mobile: '+91 99998 88777', notes: 'Test customer', tags: 'New, VIP, new' },
});
check('A1 add contact 201 + notes/tags persisted',
  r.status === 201 && r.json.contact.notes === 'Test customer' &&
  Array.isArray(r.json.contact.tags) && r.json.contact.tags.join('|') === 'New|VIP',
  `status=${r.status} tags=${JSON.stringify(r.json?.contact?.tags)}`);

// duplicate: same number, different name -> 409, nothing overwritten
r = await call('POST', '/contacts', {
  token: tA1,
  body: { name: 'Changed Name', mobile: WA, notes: 'other', tags: 'Dup' },
});
check('A1 duplicate -> 409 Contact already exists', r.status === 409 && r.json?.error === 'Contact already exists', `status=${r.status} ${JSON.stringify(r.json)}`);

// confirm no overwrite happened
const afterDup = await query('SELECT name, notes, tags FROM contacts WHERE wa_id = $1', [WA]);
const row = afterDup.rows[0];
check('duplicate did not overwrite name/notes/tags',
  row.name === 'Jatin Sharma' && row.notes === 'Test customer' && row.tags.join('|') === 'New|VIP',
  JSON.stringify(row));

// A2 duplicate of A1's contact -> also 409 (no info leak beyond what they typed)
r = await call('POST', '/contacts', { token: tA2, body: { name: 'X', mobile: WA } });
check('A2 duplicate of A1 contact -> 409 (not 201)', r.status === 409 && r.json?.error === 'Contact already exists', `status=${r.status}`);

// profile: agent1 (owner)
r = await call('GET', `/contacts/${WA}/profile`, { token: tA1 });
const p = r.json;
check('A1 profile 200 with all Module 1 fields',
  r.status === 200 && p.contact?.name === 'Jatin Sharma' && p.contact?.wa_id === WA &&
  p.contact?.notes === 'Test customer' && p.contact?.tags?.join('|') === 'New|VIP' &&
  Boolean(p.contact?.first_contact_at) && p.conversation?.assigned_staff_id === 2 &&
  p.conversation?.assigned_staff_name === 'Agent 1',
  `status=${r.status} assigned=${p?.conversation?.assigned_staff_name}`);

// profile: agent2 -> 403
r = await call('GET', `/contacts/${WA}/profile`, { token: tA2 });
check('A2 profile of A1 contact -> 403', r.status === 403, `status=${r.status}`);

// profile: admin -> 200
r = await call('GET', `/contacts/${WA}/profile`, { token: t1 });
check('Admin profile -> 200', r.status === 200, `status=${r.status}`);

// profile: unknown contact -> 404; no token -> 401
r = await call('GET', '/contacts/911111111111/profile', { token: t1 });
check('unknown contact profile -> 404', r.status === 404, `status=${r.status}`);
r = await call('GET', `/contacts/${WA}/profile`);
check('profile without token -> 401', r.status === 401, `status=${r.status}`);

// DP endpoint: still honest 404, ownership enforced
r = await call('GET', `/contacts/${WA}/picture`, { token: tA1 });
check('picture -> 404 (Meta has no customer DP) for owner', r.status === 404, `status=${r.status}`);
r = await call('GET', `/contacts/${WA}/picture`, { token: tA2 });
check('picture for A2 -> 403', r.status === 403, `status=${r.status}`);

// validation: short number -> 422; missing name -> 400
r = await call('POST', '/contacts', { token: tA1, body: { name: 'Bad', mobile: '12345' } });
check('short mobile -> 422', r.status === 422, `status=${r.status}`);
r = await call('POST', '/contacts', { token: tA1, body: { mobile: '9191234567890' } });
check('missing name -> 400', r.status === 400, `status=${r.status}`);

// D: search by name / formatted number / plain digits (owner + admin scoping)
r = await call('GET', '/conversations?search=Jatin', { token: tA1 });
check('A1 search by name finds contact', r.status === 200 && r.json.items?.some((i) => i.contact_wa_id === WA), `total=${r.json?.total}`);
r = await call('GET', `/conversations?search=${encodeURIComponent('+91 99998 88777')}`, { token: tA1 });
check('A1 search by formatted number finds contact', r.status === 200 && r.json.items?.some((i) => i.contact_wa_id === WA), `total=${r.json?.total}`);
r = await call('GET', '/conversations?search=9999888777', { token: t1 });
check('Admin search by digits finds contact', r.status === 200 && r.json.items?.some((i) => i.contact_wa_id === WA), `total=${r.json?.total}`);
r = await call('GET', '/conversations?search=Jatin', { token: tA2 });
check('A2 search does NOT leak A1 contact', r.status === 200 && !r.json.items?.some((i) => i.contact_wa_id === WA), `total=${r.json?.total}`);

// cleanup test data
await query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1))', [WA]);
await query('DELETE FROM conversations WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)', [WA]);
await query('DELETE FROM contacts WHERE wa_id = $1', [WA]);
const { pool } = await import('./src/db/pool.js');
await pool.end();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
