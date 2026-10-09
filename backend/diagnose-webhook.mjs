/**
 * Being Sevak — WhatsApp webhook self-diagnostic.
 *
 *   node diagnose-webhook.mjs
 *
 * Yeh script aapke live backend ko poori tarah check karti hai WITHOUT real
 * customer number use kiye. Yeh koi message banata nahi — sirf ek TEST number
 * (919999900001) par ek realistic Meta webhook bhejti hai, verify karti hai ki
 * wo DB me save hua aur inbox API se dikhta hai, phir clean kar deti hai.
 *
 * Yeh aapko step-by-step batata hai ki problem kahan hai:
 *   - backend reachable hai ya nahi
 *   - signature verification aapke .env secret ke saath pass hota hai ya nahi
 *   - incoming webhook -> DB -> inbox tak poora flow theek hai ya nahi
 *
 * Aapke .env ke tokens/secret kabhi print nahi hote — sirf "configured / not configured".
 */
import { computeSignature } from './src/lib/whatsapp/signature.js';
import { config } from './src/config.js';
import { query, pool } from './src/db/pool.js';

const LOCAL = 'http://localhost:4000';
const WEBHOOK = `${LOCAL}/webhooks/whatsapp`;
const API = `${LOCAL}/api`;
const TEST_WA = '919999900001';

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let failures = 0;
function pass(name, ok, detail = '') {
  console.log(`${ok ? green('PASS') : red('FAIL')}  ${name}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function cleanup() {
  const convs = (await query(
    `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`,
    [TEST_WA]
  )).rows.map((r) => r.id);
  if (convs.length) {
    await query('DELETE FROM notifications WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [convs]);
    await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
  }
  await query('DELETE FROM webhook_events WHERE wa_message_id LIKE $1', ['wamid.DIAG-%']);
  await query('DELETE FROM contacts WHERE wa_id = $1', [TEST_WA]);
}

console.log(bold('\n=== Being Sevak — WhatsApp Webhook Diagnostic ===\n'));

/* ------------------------------------------------ 1. env / config presence -- */
console.log(bold('1) Environment (no secrets printed)'));
console.log(`   WHATSAPP_PHONE_NUMBER_ID : ${config.whatsapp.phoneNumberId ? green('configured') : red('MISSING')}`);
console.log(`   WHATSAPP_ACCESS_TOKEN    : ${config.whatsapp.accessToken ? green('configured') : red('MISSING')}`);
console.log(`   WHATSAPP_APP_SECRET      : ${config.whatsapp.appSecret ? green('configured') : red('MISSING')}`);
console.log(`   WHATSAPP_VERIFY_TOKEN    : ${config.whatsapp.verifyToken ? green('configured') : red('MISSING')}\n`);

/* ------------------------------------------------------ 2. backend reachable -- */
let backendUp = false;
try {
  const r = await fetch(`${LOCAL}/api/health`);
  backendUp = r.ok;
  console.log(`${backendUp ? green('PASS') : red('FAIL')}  backend reachable on ${LOCAL}`);
} catch (error) {
  console.log(`${red('FAIL')}  backend NOT reachable on ${LOCAL} -> ${error.message}`);
}
if (!backendUp) {
  console.log(red('\nBackend down hai. Pehle `npm run dev` chala kar dobara chalayein.'));
  await pool.end();
  process.exit(1);
}

/* --------------------------------- 3. webhook GET verification (handshake) -- */
const vt = await fetch(`${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.whatsapp.verifyToken)}&hub.challenge=DIAG_CHALLENGE`);
const vtBody = await vt.text();
pass('webhook GET verification (Meta handshake) works', vt.status === 200 && vtBody === 'DIAG_CHALLENGE', `status=${vt.status}`);

const vtWrong = await fetch(`${WEBHOOK}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`);
pass('webhook GET rejects a wrong verify token (403)', vtWrong.status === 403, `status=${vtWrong.status}`);

/* ------------------------------------------- 4. signature enforcement (safe) -- */
function payload(wamid) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550001666', phone_number_id: '106540352242922' },
      contacts: [{ profile: { name: 'Diagnostic' }, wa_id: TEST_WA }],
      messages: [{ from: TEST_WA, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'diagnostic probe' } }],
    } }] }],
  };
}

await cleanup();

// Bad signature must be rejected.
const badWamid = `wamid.DIAG-BAD-${Date.now()}`;
const badRaw = JSON.stringify(payload(badWamid));
const badRes = await fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${computeSignature(badRaw, 'wrong-secret-0000000000000000')}` },
  body: badRaw,
});
await new Promise((r) => setTimeout(r, 400));
const badPersisted = (await query('SELECT id FROM messages WHERE wa_message_id = $1', [badWamid])).rows[0];
pass('signature verification is ON (bad signature -> 401, not saved)',
  badRes.status === 401 && !badPersisted, `http=${badRes.status} saved=${Boolean(badPersisted)}`);

/* ----------------------------------- 5. valid signed inbound webhook -> DB -- */
const goodWamid = `wamid.DIAG-${Date.now()}`;
const goodRaw = JSON.stringify(payload(goodWamid));
const goodRes = await fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${computeSignature(goodRaw, config.whatsapp.appSecret)}` },
  body: goodRaw,
});

let goodRow = null;
for (let i = 0; i < 50 && !goodRow; i += 1) {
  goodRow = (await query(
    'SELECT id, conversation_id, direction, status FROM messages WHERE wa_message_id = $1', [goodWamid]
  )).rows[0] ?? null;
  if (!goodRow) await new Promise((r) => setTimeout(r, 100));
}
pass('valid signed inbound webhook -> 200 and saved in DB',
  goodRes.status === 200 && goodRow?.direction === 'inbound' && goodRow?.status === 'received',
  `http=${goodRes.status} saved=${Boolean(goodRow)}`);

/* ---------------------------------------- 6. duplicate webhook -> no dupe -- */
// Same wamid again — the unique index must swallow it.
const dupeRes = await fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${computeSignature(goodRaw, config.whatsapp.appSecret)}` },
  body: goodRaw,
});
await new Promise((r) => setTimeout(r, 400));
const dupeCount = (await query('SELECT COUNT(*)::int AS n FROM messages WHERE wa_message_id = $1', [goodWamid])).rows[0].n;
pass('duplicate webhook does NOT create a duplicate message',
  dupeCount === 1, `http=${dupeRes.status} rows=${dupeCount}`);

/* ----------------------------------------- 7. visible via inbox API (frontend) -- */
if (goodRow) {
  const admin = (await query(`SELECT * FROM staff WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1`)).rows[0];
  if (!admin) {
    pass('inbox API shows the message', false, 'no active admin found to test with');
  } else {
    const { signToken } = await import('./src/lib/jwt.js');
    const token = signToken(admin);
    const listRes = await fetch(`${API}/conversations?view=all&limit=100`, { headers: { Authorization: `Bearer ${token}` } });
    const listJson = await listRes.json();
    const inList = (listJson.items ?? listJson ?? []).some((c) => Number(c.id) === Number(goodRow.conversation_id));

    const threadRes = await fetch(`${API}/conversations/${goodRow.conversation_id}`, { headers: { Authorization: `Bearer ${token}` } });
    const threadJson = await threadRes.json();
    const inThread = (threadJson.messages ?? []).some((m) => (m.wa_message_id ?? m.waMessageId) === goodWamid);

    pass('inbox conversation list shows the conversation', listRes.status === 200 && inList, `http=${listRes.status} found=${inList}`);
    pass('conversation thread API shows the message', threadRes.status === 200 && inThread, `http=${threadRes.status} found=${inThread}`);
  }
}

await cleanup();
await pool.end();

/* ------------------------------------------------------------- 8. verdict -- */
console.log('');
if (failures === 0) {
  console.log(green(bold('RESULT: Backend webhook pipeline is 100% HEALTHY.')));
  console.log(green('  -> Aapka code theek hai. Agar real customer message nahi aa raha,'));
  console.log(green('     to problem BACKEND me nahi, balki Meta dashboard / webhook delivery me hai.'));
  console.log('');
  console.log(bold('  Ab ye 2 cheezein check karein (sirf Meta dashboard me):'));
  console.log('   1. Webhook Callback URL public aur reachable hai? (localhost/IP ka URL nahi chalega)');
  console.log('   2. Callback URL exactly /webhooks/whatsapp par ja raha hai?');
  console.log('   3. WhatsApp App me "messages" webhook field subscribed hai?');
  console.log('   4. App subscribed hai aur WABA se linked hai?');
} else {
  console.log(red(bold(`RESULT: ${failures} check(s) FAILED — backend me problem hai.`)));
  console.log(red('  Upar FAIL lines dekhein; woh exactly bata rahe hain ki kya toota hai.'));
}
console.log('');