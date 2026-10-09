/**
 * Verifies the "missing audio offer" fix:
 *  - listIncoming MUST include sdpOffer for a ringing inbound call (the bug)
 *  - authorisation must STILL hold (a ringing call in someone ELSE's queue
 *    must not leak the SDP)
 */
const BASE = 'http://localhost:4000/api';
const { signToken } = await import('./src/lib/jwt.js');
const { query, pool } = await import('./src/db/pool.js');
const callService = await import('./src/calls/call.service.js');
const { handleCallEvent } = await import('./src/calls/call.service.js');

let failures = 0;
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
function check(name, ok, detail = '') {
  console.log(`${ok ? g('PASS') : r('FAIL')}  ${name}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function tokenFor(email) {
  const row = (await query('SELECT id, name, email, role FROM staff WHERE email = $1 AND is_active', [email])).rows[0];
  return { token: signToken(row), id: row.id };
}

const tA1 = await tokenFor('agent1@example.com');
const tA2 = await tokenFor('agent2@example.com');

async function seed(waId, name, staffId) {
  const contactId = (await query(
    `INSERT INTO contacts (wa_id, name) VALUES ($1,$2) ON CONFLICT (wa_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [waId, name])).rows[0].id;
  const convId = (await query(
    `INSERT INTO conversations (contact_id, assigned_staff_id, status, created_at, updated_at)
     VALUES ($1,$2,'open',NOW(),NOW()) RETURNING id`, [contactId, staffId])).rows[0].id;
  return convId;
}

async function cleanup() {
  for (const wa of ['919876950101', '919876950102']) {
    const convs = (await query(
      `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.wa_id=$1`, [wa])
    ).rows.map((x) => x.id);
    if (convs.length) {
      await query('DELETE FROM call_events WHERE call_id IN (SELECT id FROM calls WHERE conversation_id = ANY($1::int[]))', [convs]);
      await query('DELETE FROM calls WHERE conversation_id = ANY($1::int[])', [convs]);
      await query('DELETE FROM conversations WHERE id = ANY($1::int[])', [convs]);
    }
    await query('DELETE FROM contacts WHERE wa_id = $1', [wa]);
  }
  await query("DELETE FROM call_events WHERE wa_call_id LIKE 'wacid.SDPFIX-%'");
}

await cleanup();
await seed('919876950101', 'SDP Alpha', tA1.id);
await seed('919876950102', 'SDP Bravo', tA2.id);

const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

// Ring a call on agent1's conversation.
const waCallId = `wacid.SDPFIX-${Date.now()}`;
await handleCallEvent({
  waCallId, customerWaId: '919876950101', direction: 'inbound', event: 'connect',
  timestamp: new Date().toISOString(), sdpType: 'offer', sdp: SDP, clientRef: null,
  status: null, startTime: null, endTime: null, duration: null, errorCode: null, errorDetail: null,
});

const incoming = await callService.listIncoming({ id: tA1.id, role: 'agent' });
const mine = incoming.items.find((c) => c.contactWaId === '919876950101');
check('listIncoming returns the ringing call to its owner', Boolean(mine), `items=${incoming.items.length}`);
check('THE FIX: the ringing call now carries sdpOffer (was the bug)',
  mine?.sdpOffer === SDP, `sdpOffer=${mine?.sdpOffer ? 'present' : 'MISSING'}`);

// Authorisation must still hold: agent2 must not receive it at all.
const other = await callService.listIncoming({ id: tA2.id, role: 'agent' });
check('authorisation intact: another agent still sees nothing',
  !other.items.some((c) => c.contactWaId === '919876950101'), `items=${other.items.length}`);

// Same check over the real HTTP route the frontend actually calls.
const res = await fetch(`${BASE}/calls/incoming`, { headers: { Authorization: `Bearer ${tA1.token}` } });
const json = await res.json();
const viaHttp = (json.items ?? []).find((c) => c.contactWaId === '919876950101');
check('GET /api/calls/incoming returns sdpOffer over HTTP',
  res.status === 200 && viaHttp?.sdpOffer === SDP, `http=${res.status} sdpOffer=${viaHttp?.sdpOffer ? 'present' : 'MISSING'}`);

await cleanup();
await pool.end();
console.log(failures === 0 ? g('\nALL PASS') : r(`\n${failures} FAILED`));
process.exitCode = failures ? 1 : 0;