/**
 * Module 5 — customer tags: catalogue API, profile add/remove, the tag filter
 * on the conversation list, admin-only management and agent permissions.
 *
 *   node test-module5.mjs
 *
 * Runs against a live server on :4000 (npm run dev in this folder).
 */
import fs from 'node:fs/promises';

const BASE = 'http://localhost:4000/api';

const { signToken } = await import('./src/lib/jwt.js');
const { query } = await import('./src/db/pool.js');
const { seedTags } = await import('./src/tags/tag.repository.js');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('tokens minted for admin / agent1 / agent2', Boolean(tAdmin && tA1 && tA2));

await seedTags();

// ---------------------------------------------------------------- fixtures --
const WA1 = '919876500001'; // owned by agent1
const WA2 = '919876500002'; // unassigned
const WA3 = '919876500003'; // created through the Add Contact form
const NAME1 = 'Tag Customer One';
const NAME2 = 'Tag Customer Two';

async function cleanup() {
  for (const wa of [WA1, WA2, WA3]) {
    await query(
      `DELETE FROM messages WHERE conversation_id IN (
         SELECT c.id FROM conversations c
           JOIN contacts ct ON ct.id = c.contact_id
          WHERE ct.wa_id = $1)`,
      [wa]
    );
    await query(
      `DELETE FROM conversations c USING contacts ct
        WHERE c.contact_id = ct.id AND ct.wa_id = $1`,
      [wa]
    );
    await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
  }
  await query(`DELETE FROM tags WHERE name LIKE 'M5 %'`);
}

async function makeFixture(waId, name, assignedStaffId) {
  const contact = await query(
    `INSERT INTO contacts (wa_id, name, notes, tags) VALUES ($1, $2, '', '{}') RETURNING id`,
    [waId, name]
  );
  const conversation = await query(
    `INSERT INTO conversations (contact_id, assigned_staff_id, status)
     VALUES ($1, $2, 'open') RETURNING id`,
    [contact.rows[0].id, assignedStaffId]
  );
  return { contactId: contact.rows[0].id, conversationId: conversation.rows[0].id };
}

await cleanup();
const agent1Id = (await query(`SELECT id FROM staff WHERE email = 'agent1@example.com'`)).rows[0].id;
const one = await makeFixture(WA1, NAME1, agent1Id);
const two = await makeFixture(WA2, NAME2, null);

// ------------------------------------------------ A. catalogue (read side) --
let r = await call('GET', '/tags', { token: tAdmin });
const items = r.json?.items ?? [];
const byName = new Map(items.map((tag) => [tag.name, tag]));
check('A1 GET /tags 200 + items array', r.status === 200 && Array.isArray(items), `status=${r.status}`);
check(
  'A2 five defaults seeded with the prescribed colours',
  ['New', 'Donation', 'Follow-up', 'Urgent', 'Pending'].every(
    (name) => byName.has(name) &&
      typeof byName.get(name).color === 'string' &&
      byName.get(name).color.startsWith('#')
  ) &&
    byName.get('New')?.color === '#16a34a' &&
    byName.get('Donation')?.color === '#2563eb',
  JSON.stringify([...byName.keys()])
);
check(
  'A3 catalogue rows carry id/name/color/assignment_count',
  items.every(
    (tag) => Number.isInteger(tag.id) && typeof tag.name === 'string' &&
      typeof tag.color === 'string' && Number.isInteger(tag.assignment_count)
  )
);

r = await call('GET', '/tags', { token: tA2 });
check('A4 agents may read the catalogue (needed to filter and to tag)', r.status === 200 && r.json.items.length > 0, `status=${r.status}`);

// ------------------------------------------------- B. create / duplicate ----
r = await call('POST', '/tags', { token: tA1, body: { name: 'M5 Alpha' } });
const alpha = r.json;
check('B1 agent creates a tag -> 201 with grey fallback colour',
  r.status === 201 && alpha?.name === 'M5 Alpha' && alpha?.color === '#6b7280',
  `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('POST', '/tags', { token: tAdmin, body: { name: 'M5 Alpha' } });
check('B2 duplicate name -> 409 "already exists"',
  r.status === 409 && r.json?.error === 'Tag "M5 Alpha" already exists',
  `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('POST', '/tags', { token: tAdmin, body: { name: 'M5 bad', color: 'red' } });
check('B3 invalid colour -> 400 (zod)', r.status === 400, `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('POST', '/tags', { token: tAdmin, body: { name: 'M5 Beta', color: '#234567' } });
const beta = r.json;
check('B4 admin creates a coloured tag -> 201', r.status === 201 && beta?.color === '#234567', `status=${r.status}`);

r = await call('POST', '/tags', { token: tA2, body: { name: 'M5 Gamma' } });
const gamma = r.json;
check('B5 second agent creates a tag too (create is for all staff)', r.status === 201, `status=${r.status}`);

// ------------------------------------------- C. rename / recolour / delete --
r = await call('PATCH', `/tags/${alpha.id}`, { token: tA1, body: { name: 'M5 Nope' } });
check('C1 agent PATCH -> 403 "Insufficient role"', r.status === 403 && r.json?.error === 'Insufficient role', `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('PATCH', `/tags/${alpha.id}`, { token: tA2, body: { name: 'M5 Nope' } });
check('C2 agent DELETE -> 403', (await call('DELETE', `/tags/${alpha.id}`, { token: tA2 })).status === 403);

r = await call('PATCH', `/tags/${alpha.id}`, { token: tAdmin, body: { name: 'M5 Alpha R', color: '#a1b2c3' } });
check('C3 admin renames + recolours -> 200',
  r.status === 200 && r.json?.name === 'M5 Alpha R' && r.json?.color === '#a1b2c3',
  `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('PATCH', '/tags/999999', { token: tAdmin, body: { name: 'M5 Ghost' } });
check('C4 PATCH unknown id -> 404', r.status === 404, `status=${r.status}`);

// ------------------------------------------------ D. tagging a customer -----
const tagPath = `/contacts/${WA1}/tags`;
r = await call('POST', tagPath, { token: tA1, body: { tagIds: [alpha.id] } });
check('D1 owner agent adds a tag -> 200 with the tag returned',
  r.status === 200 && r.json?.tags?.length === 1 && r.json.tags[0].id === alpha.id,
  `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('POST', tagPath, { token: tA1, body: { tagIds: [alpha.id] } });
check('D2 adding the same tag again is idempotent (still 1 tag)',
  r.status === 200 && r.json.tags.length === 1, `status=${r.status} tags=${r.json?.tags?.length}`);

r = await call('GET', tagPath, { token: tA1 });
check('D3 GET customer tags', r.status === 200 && r.json.tags[0]?.name === 'M5 Alpha R', JSON.stringify(r.json));

r = await call('POST', tagPath, { token: tA1, body: { tagIds: [999999] } });
check('D4 unknown tag id -> 422 "no longer exist"',
  r.status === 422 && /no longer exist/.test(r.json?.error ?? ''), `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('POST', tagPath, { token: tA1, body: { tagIds: [] } });
check('D5 empty tagIds -> 400 (zod min(1))', r.status === 400, `status=${r.status}`);

// ------------------------------------------------ E. ownership / permissions --
r = await call('GET', `/contacts/${WA1}/profile`, { token: tAdmin });
check('E1 admin opens any profile',
  r.status === 200 && r.json?.contact?.tags?.join('|') === 'M5 Alpha R',
  `status=${r.status} tags=${JSON.stringify(r.json?.contact?.tags)}`);
check('E2 profile returns tag objects (id + colour) alongside Module 1 names',
  Array.isArray(r.json?.tags) && r.json.tags[0]?.id === alpha.id && r.json.tags[0]?.color === '#a1b2c3',
  JSON.stringify(r.json?.tags));

r = await call('GET', `/contacts/${WA1}/profile`, { token: tA1 });
check('E3 owner agent opens their own profile -> 200', r.status === 200, `status=${r.status}`);

r = await call('GET', `/contacts/${WA1}/profile`, { token: tA2 });
check('E4 other agent -> 403', r.status === 403, `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('POST', tagPath, { token: tA2, body: { tagIds: [beta.id] } });
check('E5 other agent cannot tag via the API -> 403', r.status === 403, `status=${r.status} ${JSON.stringify(r.json)}`);

r = await call('DELETE', `/contacts/${WA1}/tags/${alpha.id}`, { token: tA2 });
check('E6 other agent cannot untag via the API -> 403', r.status === 403, `status=${r.status}`);

// ---------------------------------------------------- F. the tag filter ------
await call('POST', `/contacts/${WA2}/tags`, { token: tAdmin, body: { tagIds: [beta.id] } });

r = await call('GET', `/conversations?tags=${alpha.id}`, { token: tAdmin });
const alphaIds = (r.json?.items ?? []).map((c) => c.id);
check('F1 filter by one tag returns only tagged conversations',
  r.status === 200 && alphaIds.length === 1 && alphaIds[0] === one.conversationId,
  `status=${r.status} ids=${JSON.stringify(alphaIds)}`);

r = await call('GET', `/conversations?tags=${beta.id}`, { token: tAdmin });
const betaIds = (r.json?.items ?? []).map((c) => c.id);
check('F2 filter by the other tag returns only its conversation',
  betaIds.length === 1 && betaIds[0] === two.conversationId, JSON.stringify(betaIds));

r = await call('GET', `/conversations?tags=${alpha.id},${beta.id}`, { token: tAdmin });
const bothIds = (r.json?.items ?? []).map((c) => c.id);
check('F3 several tags use ANY (OR) semantics',
  bothIds.includes(one.conversationId) && bothIds.includes(two.conversationId),
  JSON.stringify(bothIds));

check('F4 every list row carries its customer tags for display',
  (r.json?.items ?? []).every((c) => Array.isArray(c.tags) && c.tags.every((t) => t.id && t.name && t.color)),
  JSON.stringify((r.json?.items ?? []).slice(0, 2).map((c) => c.tags)));

r = await call('GET', `/conversations?tags=${alpha.id}&search=${encodeURIComponent(NAME2)}`, { token: tAdmin });
check('F5 tag filter combines with search (tag + non-matching name -> empty)',
  r.status === 200 && r.json.total === 0 && r.json.items.length === 0,
  `status=${r.status} total=${r.json?.total}`);

r = await call('GET', `/conversations?tags=${alpha.id}&search=${encodeURIComponent(NAME1)}`, { token: tAdmin });
check('F6 tag filter combines with search (tag + matching name -> 1)',
  r.json.total === 1 && r.json.items[0].id === one.conversationId, `total=${r.json?.total}`);

r = await call('GET', `/conversations?tags=${alpha.id}&status=closed`, { token: tAdmin });
check('F7 tag filter combines with status (closed -> empty)', r.json.total === 0, `total=${r.json?.total}`);

r = await call('GET', `/conversations?tags=${alpha.id}&status=open`, { token: tAdmin });
check('F8 tag filter combines with status (open -> 1)', r.json.total === 1, `total=${r.json?.total}`);

r = await call('GET', '/conversations?tags=abc,,-4', { token: tAdmin });
check('F9 junk tag ids are ignored instead of hiding everything',
  r.status === 200 && r.json.total >= 2, `status=${r.status} total=${r.json?.total}`);

// Scope: the tag filter never widens who can see what.
r = await call('GET', `/conversations?tags=${alpha.id}`, { token: tA1 });
check('F10 owner agent sees their tagged conversation',
  r.json.items.length === 1 && r.json.items[0].id === one.conversationId, `total=${r.json?.total}`);

r = await call('GET', `/conversations?tags=${beta.id}`, { token: tA1 });
check('F11 tag filter respects the agent scope (unassigned chat stays hidden)',
  r.json.total === 0, `total=${r.json?.total}`);

r = await call('GET', `/conversations?tags=${alpha.id},${beta.id}`, { token: tA2 });
check('F12 agent with no matching conversation -> empty',
  r.status === 200 && r.json.total === 0, `total=${r.json?.total}`);

// --------------------------------------------- G. Add Contact free text -----
r = await call('POST', '/contacts', {
  token: tAdmin,
  body: { name: 'Tag Form Customer', mobile: '+91 98765 00003', tags: 'New, M5 Custom' },
});
check('G1 Add Contact with free-text tags -> 201',
  r.status === 201 && r.json?.contact?.tags?.join('|') === 'New|M5 Custom',
  `status=${r.status} ${JSON.stringify(r.json?.contact?.tags)}`);

r = await call('GET', `/contacts/${WA3}/profile`, { token: tAdmin });
check('G2 free-text tags became real catalogue rows with colours',
  r.status === 200 && r.json.tags.length === 2 && r.json.tags.every((t) => t.id && t.color),
  JSON.stringify(r.json.tags));
check('G3 the new custom tag is in the shared catalogue',
  (await call('GET', '/tags', { token: tA1 })).json.items.some((t) => t.name === 'M5 Custom'));

r = await call('POST', `/contacts/${WA1}/tags`, { token: tAdmin, body: { tagIds: [beta.id] } });
check('G4 customer now carries two tags', r.json.tags.length === 2, JSON.stringify(r.json.tags));
r = await call('DELETE', `/contacts/${WA1}/tags/${beta.id}`, { token: tAdmin });
check('G5 removing one tag keeps the other',
  r.status === 200 && r.json.tags.length === 1 && r.json.tags[0].id === alpha.id,
  JSON.stringify(r.json.tags));

// ------------------------------------------- H. admin delete cascades -------
await call('POST', `/contacts/${WA2}/tags`, { token: tAdmin, body: { tagIds: [gamma.id] } });
r = await call('DELETE', `/tags/${gamma.id}`, { token: tAdmin });
check('H1 admin delete -> 200 and reports how many customers lost the tag',
  r.status === 200 && r.json?.removedAssignments === 1, `status=${r.status} ${JSON.stringify(r.json)}`);

const afterDelete = await call('GET', `/contacts/${WA2}/profile`, { token: tAdmin });
check('H2 deleted tag disappears from the customer profile',
  afterDelete.json.tags.every((t) => t.id !== gamma.id), JSON.stringify(afterDelete.json.tags));

const stillThere = await call('GET', `/contacts/${WA2}/profile`, { token: tAdmin });
check('H3 deleting a tag never touches the customer or the chat',
  stillThere.status === 200 && stillThere.json.contact?.name === NAME2 &&
    (await query('SELECT id FROM conversations WHERE id = $1', [two.conversationId])).rowCount === 1);

r = await call('DELETE', `/tags/${alpha.id}`, { token: tA1 });
check('H4 agent DELETE -> 403', r.status === 403, `status=${r.status}`);

// ------------------------------------- I. tags stay inside the CRM (privacy) --
const outboundSources = await Promise.all(
  ['src/conversations/outbound.service.js', 'src/lib/whatsapp/client.js', 'src/conversations/template.service.js'].map(
    (file) => fs.readFile(new URL(`./${file}`, import.meta.url), 'utf8')
  )
);
check('I1 WhatsApp payloads are built without tags (internal only)',
  outboundSources.every((source) => !/\btags?\b/i.test(source)));

// ---------------------------------------------------------------- cleanup ----
await cleanup();
const leaked = (await call('GET', '/tags', { token: tAdmin })).json.items.filter((t) => t.name.startsWith('M5 '));
check('J1 fixtures cleaned up (no M5 tags left behind)', leaked.length === 0, JSON.stringify(leaked.map((t) => t.name)));

// ----------------------------------------------------------------- report ----
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const entry of failed) console.log(`  - ${entry.name}  ->  ${entry.detail}`);
  process.exitCode = 1;
}
process.exit();
