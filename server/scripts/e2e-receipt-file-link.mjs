// End-to-end check of the signed receipt-file endpoint against the real S3
// bucket, using the real router and the real controller.
//
// This is the whole approach in one script: a donor PDF goes into a bucket that
// refuses anonymous reads, Meta-style anonymous GET fetches a signed link, and
// the bytes come back. If this passes, the 403 that blocked every receipt is
// genuinely solved without making anything public.
//
// Throwaway: uploads one scratch object and deletes it before exiting.

import 'dotenv/config';
import express from 'express';
import whatsappRoutes from '../src/routes/whatsappRoutes.js';
import { signReceiptFile, buildReceiptFileUrl } from '../src/services/receiptFileLink.js';
import db from '../src/config/db.js';

// A real, valid, single-page PDF. Receipt-shaped content is avoided on purpose:
// this file gets uploaded to a live bucket.
const PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'
);

const KEY = `receipts/e2e-probe-${Date.now()}.pdf`;
const store = db.storage.from('legacy', 'receipts');
const account = store.accountName;

const log = (label, value) => console.log(`${label}: ${value}`);
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const server = express();
server.set('trust proxy', 'loopback');
// Mounted as production mounts it: /api/whatsapp.
server.use('/api/whatsapp', whatsappRoutes);

const httpServer = await new Promise((resolve) => {
  const s = server.listen(0, '127.0.0.1', () => resolve(s));
});
const port = httpServer.address().port;
const base = `http://127.0.0.1:${port}`;
const linkFor = (token) => buildReceiptFileUrl({ protocol: 'http', get: () => `127.0.0.1:${port}` }, token);

try {
  log('storage account', account);

  const up = await store.upload(KEY, PDF, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error(`upload failed: ${up.error.message}`);
  log('uploaded', KEY);

  // 1. What the bucket URL does for an anonymous reader right now. This is
  //    reported, not asserted: the endpoint's correctness does not depend on it,
  //    and the answer is expected to differ between environments.
  const { data: pub } = db.storage.from('legacy', 'receipts').getPublicUrl(KEY);
  const bucketProbe = await fetch(pub.publicUrl).catch((e) => ({ status: 0, error: e.message }));
  log('anonymous bucket GET', `${bucketProbe.status ?? bucketProbe.error} (200 here means the bucket is public)`);

  // 2. The signed link, fetched anonymously, the way Meta will fetch it.
  const token = signReceiptFile({ account, key: KEY });
  const good = await fetch(linkFor(token));

  check('signed link returns 200', good.status === 200, `got ${good.status}`);
  check('served as application/pdf', good.headers.get('content-type') === 'application/pdf', good.headers.get('content-type'));
  check('not cached by intermediaries', (good.headers.get('cache-control') || '').includes('no-store'), good.headers.get('cache-control'));
  check('sniffing disabled', good.headers.get('x-content-type-options') === 'nosniff');

  const body = Buffer.from(await good.arrayBuffer());
  check('bytes match the uploaded PDF exactly', body.equals(PDF), `${body.length} vs ${PDF.length} bytes`);

  // 3. A tampered token must not read the object, and must not reveal it exists.
  const tampered = `${token.split('.')[0]}.${'A'.repeat(43)}`;
  const bad = await fetch(linkFor(tampered));
  check('tampered signature is refused', bad.status === 404, `got ${bad.status}`);

  // 4. Traversal out of the receipts prefix, signed with the real key.
  let traversalStatus = 0;
  try {
    signReceiptFile({ account, key: 'receipts/../../root' });
  } catch {
    traversalStatus = 400;
  }
  check('traversal key cannot be signed', traversalStatus === 400);

  // 5. A genuinely missing object is 404, not a 500 that leaks internals.
  const missing = await fetch(linkFor(signReceiptFile({ account, key: `receipts/e2e-absent-${Date.now()}.pdf` })));
  check('missing object is 404', missing.status === 404, `got ${missing.status}`);
} finally {
  // Cleanup must not depend on the server closing cleanly, and vice versa.
  try { httpServer.closeAllConnections?.(); httpServer.close(); } catch { /* already closed */ }
  const del = await store.remove(KEY);
  console.log(`${del.error ? 'WARN' : 'cleaned up'} scratch object ${KEY}${del.error ? `: ${del.error.message}` : ''}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
// Set the code rather than calling process.exit(), which races the listener
// teardown and trips an assertion inside libuv on Windows.
process.exitCode = failures === 0 ? 0 : 1;