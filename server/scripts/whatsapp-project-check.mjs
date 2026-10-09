// Checks one project's WhatsApp account end to end, and optionally sends a real
// test receipt to a given number.
//
// Exists because "the message did not arrive" has three very different causes --
// a broken code path, a document Meta cannot fetch, and a Meta-side number that
// has been disabled -- and the API response looks identical (HTTP 200 "accepted")
// in all three. This reports which one you are actually looking at.
//
//   node scripts/whatsapp-project-check.mjs <project>            # report only
//   node scripts/whatsapp-project-check.mjs <project> <recipient>  # also send
//
// The token is read from the database and never printed: only its length and a
// short prefix, which is enough to tell a rotated token from a stale one.

import 'dotenv/config';
import pg from 'pg';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import db from '../src/config/db.js';

const PROJECT = String(process.argv[2] || '').trim().toLowerCase();
const TO = String(process.argv[3] || '').replace(/\D/g, '');
const HOLD_MS = Number(process.env.HOLD_MS || 120000);

if (!PROJECT) { console.error('usage: node scripts/whatsapp-project-check.mjs <project> [recipient]'); process.exit(1); }

const sslUrl = process.env.DATABASE_URL.includes('?')
  ? process.env.DATABASE_URL + '&sslmode=no-verify'
  : process.env.DATABASE_URL + '?sslmode=no-verify';
const conn = new pg.Client({ connectionString: sslUrl, connectionTimeoutMillis: 20000 });
await conn.connect();
const { rows } = await conn.query(
  'select waba_id, phone_number_id, access_token, is_active from whatsapp_accounts where project = $1',
  [PROJECT],
);
await conn.end();

if (!rows.length) {
  const list = await (async () => {
    const c2 = new pg.Client({ connectionString: sslUrl, connectionTimeoutMillis: 20000 });
    await c2.connect();
    const r = await c2.query('select project from whatsapp_accounts order by project');
    await c2.end();
    return r.rows.map((x) => x.project);
  })();
  console.log(`no account row for "${PROJECT}". known projects: ${list.join(', ')}`);
  process.exit(1);
}

const WABA = rows[0].waba_id;
const PHONE = rows[0].phone_number_id;
const TOKEN = rows[0].access_token;

// Meta rate-limits and occasionally drops a TLS connection outright; a single
// flaky read would otherwise look like "this account is broken" when it is not.
const graph = async (path, tries = 4) => {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`,
        { signal: AbortSignal.timeout(30000) },
      );
      return await res.json().catch(() => ({}));
    } catch (err) {
      if (i === tries) return { error: { code: 'NETWORK', message: err.message } };
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
};

console.log(`\n===== ${PROJECT.toUpperCase()} =====`);
console.log(`  waba   ${WABA}`);
console.log(`  phone  ${PHONE}`);
console.log(`  active ${rows[0].is_active}`);
console.log(`  token  len=${TOKEN.length} prefix=${TOKEN.slice(0, 14)}...`);

const me = await graph('/me');
console.log(me.error
  ? `  /me    FAILED  code=${me.error.code} ${me.error.message}`
  : `  /me    ok  id=${me.id} name=${me.name}`);

const waba = await graph(`/${WABA}?fields=name`);
console.log(waba.error
  ? `  waba   FAILED  code=${waba.error.code} ${waba.error.message}`
  : `  waba   ok  "${waba.name}"`);

const phone = await graph(`/${PHONE}?fields=display_phone_number,status,quality_rating,account_mode,name_status`);
console.log(phone.error
  ? `  phone  FAILED  ${JSON.stringify(phone.error)}`
  : `  phone  ${JSON.stringify(phone.data ?? phone)}`);

const state = phone.data?.status;
const VERDICT = {
  BANNED: 'DISABLED by Meta -- /messages will return 200 "accepted" and nothing will ever deliver. Only a Meta appeal fixes this.',
  CONNECTED: 'usable',
  PENDING: 'not usable yet',
  DELETED_DELETING: 'deleted',
  MIGRATED: 'migrated out of Cloud API',
  RATE_LIMITED: 'rate limited',
  FLAGGED: 'flagged',
  PENDING_VERIFICATION: 'pending verification',
};
if (state) console.log(`  VERDICT: ${VERDICT[state] ?? `unknown status "${state}"`}`);

const templates = await graph(`/${WABA}/message_templates?limit=100`);
if (templates.error) {
  console.log(`  templates  FAILED  code=${templates.error.code} ${templates.error.message}`);
} else {
  console.log(`  templates  ${templates.data.length}`);
  for (const t of templates.data) {
    const h = (t.components || []).find((x) => x.type === 'HEADER');
    console.log(`    ${t.status.padEnd(9)} ${String(t.name).padEnd(26)} [${t.language}] header=${h ? h.format : 'NONE'}`);
  }
}

if (!TO) {
  console.log('\n(no recipient given - report only, nothing sent)\n');
  process.exit(state === 'CONNECTED' ? 0 : 2);
}

console.log(`\n--- sending a test receipt to ${TO} ---`);

const usable = templates.data?.filter((t) => /receipt/i.test(t.name) && t.status === 'APPROVED');
const tpl = usable?.[0];
if (!tpl) {
  console.log('  no APPROVED template with "receipt" in its name -> nothing to send');
  process.exit(3);
}

const body = (tpl.components || []).find((x) => x.type === 'BODY');
const named = body?.example?.body_text_named_params || [];
const positional = (body?.text || '').match(/\{\{\d+\}\}/g) || [];
const bodyParams = named.length
  ? named.map((n) => ({ type: 'text', text: 'Ashray Test', parameter_name: n.param_name }))
  : positional.map(() => ({ type: 'text', text: 'Ashray Test' }));

const PDFDocument = (await import('pdfkit')).default;
const PDF = await new Promise((res, rej) => {
  const d = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks = [];
  d.on('data', (x) => chunks.push(x));
  d.on('end', () => res(Buffer.concat(chunks)));
  d.on('error', rej);
  d.font('Helvetica-Bold').fontSize(18).text(`${PROJECT.toUpperCase()}`, { align: 'center' });
  d.moveDown(0.5);
  d.font('Helvetica').fontSize(12).text('WhatsApp receipt delivery test', { align: 'center' });
  d.moveDown(2);
  d.fontSize(11).text('This is not a real receipt.', { align: 'center' });
  d.moveDown(0.5);
  d.fontSize(9).text(new Date().toISOString(), { align: 'center' });
  d.end();
});

const raw = db.storage.raw('legacy');
const store = db.storage.from('legacy', 'receipts');
const name = `${PROJECT}-presign-test-${Date.now()}.pdf`;
const fullKey = `receipts/${name}`;
let link = null;

try {
  const up = await store.upload(name, PDF, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error(`upload failed: ${up.error.message}`);
  console.log(`  uploaded ${fullKey} (${PDF.length} bytes)`);

  link = await getSignedUrl(raw.client, new GetObjectCommand({ Bucket: raw.bucket, Key: fullKey }), { expiresIn: 3600 });
  const probe = await fetch(link);
  const got = Buffer.from(await probe.arrayBuffer());
  console.log(`  presigned URL fetch: HTTP ${probe.status} bytes=${got.length} identical=${got.equals(PDF)}`);

  const components = [];
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });
  components.push({ type: 'header', parameters: [{ type: 'document', document: { link, filename: 'receipt.pdf' } }] });

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${PHONE}/messages?access_token=${encodeURIComponent(TOKEN)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: TO,
        type: 'template',
        template: { name: tpl.name, language: { code: tpl.language }, components },
      }),
    },
  );
  const json = await res.json().catch(() => ({}));
  console.log(`  send: HTTP ${res.status}`);
  console.log(`  ${JSON.stringify(json)}`);
  if (state === 'BANNED') console.log('  NOTE: this account is BANNED, so "accepted" here does not mean delivery.');
} finally {
  if (link) {
    console.log(`  holding ${Math.round(HOLD_MS / 1000)}s while Meta fetches the document...`);
    await new Promise((r) => setTimeout(r, HOLD_MS));
    await raw.client.send(new DeleteObjectCommand({ Bucket: raw.bucket, Key: fullKey })).catch(() => {});
    console.log(`  cleaned up ${fullKey}`);
  }
}