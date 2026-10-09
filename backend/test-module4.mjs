/**
 * Module 4 — Approved Meta Template Library.
 *
 * Covers three layers:
 *   1. the pure component builder (synthetic definitions, because the live WABA
 *      has no body-variable / button templates today),
 *   2. the approved-only gate (unknown, wrong-language and non-approved
 *      templates are rejected BEFORE any row is written or Meta is called),
 *   3. the HTTP contract: permission enforcement, zod validation, storage of
 *      template_name / template_language / template_params, and no credential
 *      leakage in any response.
 */

const BASE = 'http://localhost:4000/api';
const WA_T = '919999777888';
const RUN = Date.now();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const { ingestWebhookPayload } = await import('./src/conversations/inbound.service.js');
const { buildTemplatePayload, definitionButtons, prepareTemplateSend, extractTokens } = await import(
  './src/conversations/template.service.js'
);
const { buildTemplateComponents, listApprovedTemplates } = await import('./src/lib/whatsapp/client.js');

const SECRETS = [process.env.WHATSAPP_ACCESS_TOKEN, process.env.WHATSAPP_APP_SECRET].filter(Boolean);

/** Every response body the agent can see must be free of Meta credentials. */
function noSecrets(name, text) {
  const leaked = SECRETS.find((secret) => String(text ?? '').includes(secret));
  check(name, !leaked && !String(text ?? '').includes('EAAa'), leaked ? 'credential leaked' : 'clean');
}

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
  return { status: res.status, json, raw: JSON.stringify(json ?? null) };
}

async function expect422(name, fn) {
  try {
    const value = await fn();
    check(name, false, `no error thrown -> ${JSON.stringify(value)}`);
  } catch (error) {
    check(name, error?.status === 422, `status=${error?.status} ${error?.message}`);
  }
}

function inboundPayload(waId, text) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: waId, profile: { name: 'Template Tester' } }],
      messages: [{ from: waId, id: `wamid.M4-${RUN}-${Math.random().toString(36).slice(2, 10)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

const tAdmin = await tokenFor('admin@example.com');
const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');
check('tokens minted', Boolean(tAdmin && tA1 && tA2));

// ---------------------------------------------------------------------------
// 1. Pure builder — synthetic definitions (the live WABA has no such template)
// ---------------------------------------------------------------------------
const synthetic = {
  name: 'promo_positional',
  status: 'APPROVED',
  parameter_format: 'POSITIONAL',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Our {{1}} is live!' },
    { type: 'BODY', text: 'Hi {{1}}, code {{2}} gives {{3}} off.' },
    { type: 'FOOTER', text: 'Terms apply' },
    { type: 'BUTTONS', buttons: [
      { type: 'QUICK_REPLY', text: 'Not interested' },
      { type: 'URL', text: 'Shop', url: 'https://shop.example/{{1}}', example: ['summer'] },
      { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+15550001111' },
    ] },
  ],
};

const built = await buildTemplatePayload(synthetic, {
  headerVariables: ['Sale'],
  variables: ['Jatin', 'SAVE20', '20'],
  buttonParams: [{ index: 1, value: 'summer' }],
});

const bodyComponent = built.components.find((c) => c.type === 'body');
const headerComponent = built.components.find((c) => c.type === 'header');
const buttonComponent = built.components.find((c) => c.type === 'button');
check('positional body parameters in token order',
  bodyComponent?.parameters?.map((p) => p.text).join(',') === 'Jatin,SAVE20,20' &&
  !('parameter_name' in bodyComponent.parameters[0]),
  JSON.stringify(bodyComponent));
check('positional header text parameter', headerComponent?.parameters?.[0]?.text === 'Sale');
check('dynamic URL button becomes a url component',
  buttonComponent?.sub_type === 'url' && buttonComponent.index === '1' &&
  buttonComponent.parameters[0].text === 'summer',
  JSON.stringify(buttonComponent));
check('rendered body stored for the chat', built.body === 'Hi Jatin, code SAVE20 gives 20 off.', built.body);
check('stored params carry what was sent',
  built.params?.variables?.length === 3 && built.params?.buttonParams?.[0]?.value === 'summer',
  JSON.stringify(built.params));
check('static buttons are not sent as parameters',
  built.components.filter((c) => c.type === 'button').length === 1);

await expect422('missing body variable -> 422', () =>
  buildTemplatePayload(synthetic, { headerVariables: ['Sale'], variables: ['Jatin'], buttonParams: [{ index: 1, value: 's' }] }));
await expect422('unresolved placeholder value -> 422', () =>
  buildTemplatePayload(synthetic, { headerVariables: ['Sale'], variables: ['{{1}}', 'SAVE20', '20'], buttonParams: [{ index: 1, value: 's' }] }));
await expect422('stray button value on a static button -> 422', () =>
  buildTemplatePayload(synthetic, { headerVariables: ['Sale'], variables: ['a', 'b', 'c'], buttonParams: [{ index: 0, value: 'nope' }] }));
await expect422('missing header variable -> 422', () =>
  buildTemplatePayload(synthetic, { variables: ['a', 'b', 'c'], buttonParams: [{ index: 1, value: 's' }] }));

// NAMED parameter format: parameter_name must be the token, not a positional index.
const namedDef = {
  name: 'named_body',
  parameter_format: 'NAMED',
  components: [{ type: 'BODY', text: 'Thanks {{first_name}} for paying {{amount}}.' }],
};
const namedBuilt = await buildTemplatePayload(namedDef, { variables: ['Jatin', '500'] });
check('NAMED parameters carry parameter_name',
  namedBuilt.components[0].parameters.every((p) => typeof p.parameter_name === 'string') &&
  namedBuilt.components[0].parameters[0].parameter_name === 'first_name',
  JSON.stringify(namedBuilt.components));
// buildTemplateComponents is the last gate before Meta — it must accept our output.
const namedCheck = await buildTemplateComponents(
  { name: 'named_body', language: 'en', components: namedBuilt.components },
  namedDef
);
check('client-side named validation accepts builder output', Array.isArray(namedCheck) && namedCheck.length === 1);

// Older Meta shape: type BUTTON + sub_type + index (instead of a BUTTONS container).
const legacyButtons = definitionButtons({
  components: [{ type: 'BUTTON', sub_type: 'URL', index: 2, parameters: [{ type: 'text', url: 'https://y/{{1}}' }] }],
});
check('legacy BUTTON shape detected as a dynamic URL button',
  legacyButtons.length === 1 && legacyButtons[0].kind === 'URL' && legacyButtons[0].index === 2 &&
  legacyButtons[0].url.includes('{{'),
  JSON.stringify(legacyButtons));

const mediaDef = {
  name: 'image_header',
  status: 'APPROVED',
  components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://lookaside.example/handle'] } }],
};
await expect422('media header type mismatch -> 422', () =>
  buildTemplatePayload(mediaDef, { headerMedia: { type: 'video', url: 'https://x/y.mp4' } }));
await expect422('variables supplied to a template without body variables -> 422', () =>
  buildTemplatePayload({ name: 'plain', components: [{ type: 'BODY', text: 'hello' }] }, { variables: ['x'] }));

check('extractTokens handles positional and named forms',
  extractTokens('{{1}} / {{first_name}}').join(',') === '1,first_name');

// ---------------------------------------------------------------------------
// 2. Approved-only gate against the live WABA
// ---------------------------------------------------------------------------
await expect422('unknown template name -> 422 (not approved)', () =>
  prepareTemplateSend({ name: `definitely_not_real_${RUN}`, language: 'en' }));
await expect422('wrong language for a real template -> 422', () =>
  prepareTemplateSend({ name: 'hello_world', language: 'hi' }));

const helloWorld = await prepareTemplateSend({ name: 'hello_world', language: 'en_US' });
check('approved template builds without components (no fake params)',
  helloWorld && helloWorld.components === undefined,
  JSON.stringify(helloWorld));

// Legacy callers may pass Meta-shaped components themselves; they pass through.
const passthrough = await prepareTemplateSend({
  name: 'hello_world',
  language: 'en_US',
  components: [{ type: 'body', parameters: [{ type: 'text', text: 'hi' }] }],
});
check('explicit Meta components pass through unchanged',
  passthrough.components?.[0]?.parameters?.[0]?.text === 'hi');

const { items: approved } = await listApprovedTemplates();
check('live template list is APPROVED-only', approved.length > 0 && approved.every((t) => t.status === 'APPROVED'),
  approved.map((t) => `${t.name}/${t.language}/${t.category}`).join(', '));

// Media header resolution is read-only (downloads Meta's example handle).
const pitru = approved.find((t) => t.name === '_pitru_paksh');
if (pitru) {
  const withHeader = await buildTemplatePayload(pitru, { headerMedia: { type: 'image', url: pitru.components?.find((c) => c.type === 'HEADER')?.example?.header_handle?.[0] } });
  const headerParam = withHeader.components.find((c) => c.type === 'header')?.parameters?.[0];
  check('media header resolves to an asset', Boolean(headerParam?.image?.id || headerParam?.image?.link),
    JSON.stringify(headerParam));
  check('media header recorded for the chat',
    Boolean(withHeader.params?.header?.mediaPath || withHeader.params?.header?.url),
    JSON.stringify(withHeader.params?.header));
} else {
  check('media header resolution (no _pitru_paksh template)', false, 'template missing from WABA');
}

// ---------------------------------------------------------------------------
// 3. HTTP contract
// ---------------------------------------------------------------------------
const listRes = await call('GET', '/whatsapp/templates', { token: tA1 });
check('template list returns 200 with items', listRes.status === 200 && Array.isArray(listRes.json?.items), `status=${listRes.status}`);
noSecrets('template list leaks no credentials', listRes.raw);

await ingestWebhookPayload(inboundPayload(WA_T, 'Please send me the offer details'));
const conv = (await query('SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1', [WA_T])).rows[0];
check('template test conversation created', Boolean(conv?.id));
await call('PUT', `/conversations/${conv.id}/assign`, { token: tAdmin, body: { assignedStaffId: 2 } });

const countRows = async () =>
  (await query("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id=$1 AND type='template'", [conv.id])).rows[0].n;

// 3a. permission: an agent who does not own the conversation cannot template-send
let r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA2, body: { type: 'template', name: 'hello_world', language: 'en_US' } });
check('agent2 template send to agent1 conversation -> 403', r.status === 403, `status=${r.status}`);

// 3b. approval gate happens before anything is stored
let before = await countRows();
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: `missing_${RUN}`, language: 'en' } });
check('unknown template -> 422 over HTTP', r.status === 422, `status=${r.status} ${r.raw?.slice(0, 160)}`);
check('unknown template writes no message row', (await countRows()) === before, `rows=${await countRows()}`);
noSecrets('rejection body leaks no credentials', r.raw);

r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: 'hello_world', language: 'hi' } });
check('wrong language -> 422 over HTTP', r.status === 422, `status=${r.status}`);

// 3c. variable validation against the real definition
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: 'hello_world', language: 'en_US', variables: ['x'] } });
check('variables for a variable-less template -> 422', r.status === 422 && /no variables/i.test(r.raw), `status=${r.status}`);

r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: '_pitru_paksh', language: 'en', headerMedia: { type: 'video', url: 'https://x/y.mp4' } } });
check('wrong header media type -> 422', r.status === 422 && /IMAGE header/i.test(r.raw), `status=${r.status}`);

// 3d. zod validation
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: 'hello_world', language: 'en_US', buttonParams: [{ index: 0, value: '' }] } });
check('empty button value -> 400 (zod)', r.status === 400, `status=${r.status}`);
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: 'hello_world', language: 'en_US', headerMedia: { type: 'audio', url: 'https://x/y.mp3' } } });
check('unsupported header media type -> 400 (zod)', r.status === 400, `status=${r.status}`);
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: '', language: 'en_US' } });
check('empty template name -> 400 (zod)', r.status === 400, `status=${r.status}`);

// 3e. a real approved template send. The row is written before dispatch by
//     design, so Meta's answer (sent, or rejected for a fake number) only
//     changes the HTTP status — never the stored metadata.
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: 'hello_world', language: 'en_US' } });
const row = (await query(
  `SELECT id, status, body, template_name, template_language, template_params, sent_by_staff_id
     FROM messages WHERE conversation_id=$1 AND type='template' ORDER BY id DESC LIMIT 1`, [conv.id])).rows[0];
check('template send stores name + language + params',
  row?.template_name === 'hello_world' && row?.template_language === 'en_US' && row?.template_params !== null,
  JSON.stringify({ status: row?.status, name: row?.template_name, language: row?.template_language }));
check('template send answers 201 (or 502 when Meta rejects a fake number)',
  r.status === 201 || r.status === 502, `status=${r.status} ${r.raw?.slice(0, 200)}`);
check('template body keeps a readable placeholder',
  String(row?.body ?? '').includes('hello_world'), String(row?.body));
check('template send keeps assignment ownership', row?.sent_by_staff_id === 2, `staff=${row?.sent_by_staff_id}`);
noSecrets('send response leaks no credentials', r.raw);

const thread = await call('GET', `/conversations/${conv.id}?markRead=false`, { token: tA1 });
const threadTemplate = thread.json?.messages?.find((m) => m.id === row?.id);
check('thread exposes template metadata for the bubble',
  threadTemplate?.template_name === 'hello_world' && threadTemplate?.template_language === 'en_US',
  JSON.stringify({ name: threadTemplate?.template_name, language: threadTemplate?.template_language }));
noSecrets('thread leaks no credentials', thread.raw);

// 3f. closed conversations stay closed for templates too
await call('PATCH', `/conversations/${conv.id}/status`, { token: tAdmin, body: { status: 'closed' } });
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'template', name: 'hello_world', language: 'en_US' } });
check('template send into a closed conversation -> 409', r.status === 409, `status=${r.status}`);
await call('PATCH', `/conversations/${conv.id}/status`, { token: tAdmin, body: { status: 'open' } });

// ---------------------------------------------------------------------------
// 4. regressions
// ---------------------------------------------------------------------------
r = await call('GET', '/health', { token: tAdmin });
check('health ok', r.status === 200 && r.json?.status === 'ok');
r = await call('GET', `/contacts/${WA_T}/profile`, { token: tA1 });
check('customer profile still works (module 1)', r.status === 200, `status=${r.status}`);
r = await call('POST', `/conversations/${conv.id}/messages`, { token: tA1, body: { type: 'text', body: 'free text still works' } });
check('free-text reply still works (module 1/3)', r.status === 201 || r.status === 502, `status=${r.status}`);
r = await call('GET', '/conversations/messages/search?search=offer', { token: tA1 });
check('message search still works (module 3)', r.status === 200, `status=${r.status}`);

await query('DELETE FROM messages WHERE conversation_id = $1', [conv.id]);
await query('DELETE FROM conversations WHERE id = $1', [conv.id]);
await query('DELETE FROM contacts WHERE wa_id = $1', [WA_T]);
await pool.end();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
