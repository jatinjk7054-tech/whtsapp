// Attachment preflight for WhatsApp template sends.
//
// The behaviour under test is the guard that stops a receipt send being reported
// as successful when the receipt PDF is not actually downloadable by Meta. The
// failure this exists for was silent: POST /messages returns 200, the Accounts
// panel clears the row, and error 131053 only surfaces minutes later on the
// webhook. So the assertions are about *refusing to bless an unreachable URL*,
// not about any Meta interaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAttachmentReachable, describeUnreachableAttachment, isPresignedAttachment } from './mediaReachability.js';

const URL_UNDER_TEST = 'https://receipts.example.invalid/receipts/r1.pdf';

// Shaped like the URLs db.storage.presignDownload() actually hands to Meta.
// Every value is fake: isPresignedAttachment() only checks that the two
// parameters are present, and fetch is stubbed, so nothing here is ever verified
// against S3. The key ID is AWS's published documentation example rather than a
// real one -- a live key ID must not reach git history, where it is public and
// permanent. The project's own scripts/security-check.mjs treats AWS key IDs as
// rotation-worthy findings, but it skips test files, so nothing else would
// catch it here.
const PRESIGNED_URL_UNDER_TEST =
  'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/receipts/receipts/r1.pdf' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD' +
  '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261002%2Fap-south-1%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20261002T081555Z&X-Amz-Expires=3600' +
  '&X-Amz-Signature=8f89d6e351407b4f7faf397710fd3b66fb5bef9ca028d91cb3e8ecf4d6974cbe' +
  '&X-Amz-SignedHeaders=host&x-id=GetObject';

const stubFetch = (handler) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ...init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
};

const statusResponse = (status) => ({ status, statusText: `status ${status}` });

test('a publicly readable attachment passes on the cheap HEAD probe', async () => {
  const fetchImpl = stubFetch(() => statusResponse(200));
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.method, 'HEAD');
  // HEAD first: a 600KB receipt should not be downloaded just to be checked.
  assert.equal(fetchImpl.calls.length, 1);
});

test('a ranged GET 206 counts as readable', async () => {
  const fetchImpl = stubFetch(() => statusResponse(206));
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 206);
});

test('the 403 that broke every production send is reported, not swallowed', async () => {
  const fetchImpl = stubFetch(() => statusResponse(403));
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.reason, 'http');
  assert.equal(result.method, 'HEAD', 'a hard refusal must not be retried with another verb');
  assert.equal(fetchImpl.calls.length, 1);
});

test('a 403 on a bare bucket URL is not blamed on the bucket policy', () => {
  const message = describeUnreachableAttachment(URL_UNDER_TEST, { status: 403, reason: 'http' });

  assert.match(message, /HTTP 403/);
  assert.match(message, /receipts\.example\.invalid/);
  // The operator's first question is "is this my template or my donor?" and the
  // answer is neither. The message has to say so or the next person re-uploads the
  // PDF for the fifth time.
  assert.match(message, /not a\s+donor or template problem/i);

  // The old text said "Grant s3:GetObject to Principal "*" on the receipts/
  // prefix". Acting on that publishes every donor PAN, address and amount in the
  // bucket, and it sent a real investigation off to AWS instead of to the
  // link-issuing path that had actually dropped the credential.
  assert.doesNotMatch(message, /Grant s3:GetObject to Principal "\*"/);
  // Not merely stopping the suggestion: it has to say the bucket is private on
  // purpose, or the next reader concludes something is misconfigured.
  assert.match(message, /meant to stay private/i);
  // And it has to name the two shapes of link that would have worked.
  assert.match(message, /presigned/i);
  assert.match(message, /receipt-file/i);
});

test('a missing object is described as a readback failure', () => {
  const message = describeUnreachableAttachment(URL_UNDER_TEST, { status: 404, reason: 'http' });
  assert.match(message, /not at the URL/i);
  assert.match(message, /cannot be read back/i);
});

// A SigV4 presigned URL signs the HTTP method, so S3 answers 403 to a HEAD of a
// URL it will happily serve in full to a GET. Measured against the live receipts
// bucket for a real 124105-byte PDF: HEAD 403, ranged GET 206, plain GET 200.
// Probing with HEAD therefore refused a healthy receipt, and the operator was
// told to grant the bucket to Principal "*" -- which is not the fix, and would
// have published every donor PAN and address in it.

test('a presigned S3 URL is recognised as self-authorised', () => {
  assert.equal(isPresignedAttachment(PRESIGNED_URL_UNDER_TEST), true);
  assert.equal(isPresignedAttachment(URL_UNDER_TEST), false, 'a plain bucket URL is not presigned');
});

test('a presigned S3 URL is probed with GET, never HEAD', async () => {
  const fetchImpl = stubFetch((_url, init) => (
    init.method === 'HEAD' ? statusResponse(403) : statusResponse(206)
  ));
  const result = await checkAttachmentReachable(PRESIGNED_URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'GET');
  assert.deepEqual(
    fetchImpl.calls.map(c => c.method),
    ['GET'],
    'a single ranged GET: HEAD is refused by S3 for a presigned URL and would end the check',
  );
  assert.equal(fetchImpl.calls[0].headers.Range, 'bytes=0-0', 'the probe must not pull the whole PDF');
});

test('a rejected presigned link is never explained as a public-bucket problem', () => {
  const message = describeUnreachableAttachment(PRESIGNED_URL_UNDER_TEST, { status: 403, reason: 'http' });

  assert.match(message, /signed download link was rejected/i);
  // Following the old advice here would have exposed every donor in the bucket.
  assert.doesNotMatch(message, /s3:GetObject/);
  assert.doesNotMatch(message, /Principal "\*"/);
  // It has to actively push back, not just stay silent, or the operator still
  // walks off to add a public policy.
  assert.match(message, /do not add a public bucket policy/i);
  assert.match(message, /re-?send the receipt/i);
});

test('an expired presigned link still fails closed', async () => {
  const fetchImpl = stubFetch(() => statusResponse(403));
  const result = await checkAttachmentReachable(PRESIGNED_URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, false, 'a 403 must never wave the send through');
  assert.equal(result.status, 403);
  assert.equal(result.method, 'GET');
});

test('a presigned URL for a missing object is still a 404', async () => {
  const fetchImpl = stubFetch(() => statusResponse(404));
  const result = await checkAttachmentReachable(PRESIGNED_URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('a host that refuses HEAD is retried with a ranged GET', async () => {
  const fetchImpl = stubFetch((_url, init) => (
    init.method === 'HEAD' ? statusResponse(405) : statusResponse(200)
  ));
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'GET');
  assert.deepEqual(fetchImpl.calls.map(c => c.method), ['HEAD', 'GET']);
  assert.equal(fetchImpl.calls[1].headers.Range, 'bytes=0-0', 'the fallback GET must not pull the whole PDF');
});

test('a host that refuses both verbs ends up reporting the GET verdict', async () => {
  const fetchImpl = stubFetch((_url, init) => (
    init.method === 'HEAD' ? statusResponse(405) : statusResponse(403)
  ));
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.method, 'GET');
});

test('a silent host is reported as a timeout, not as a broken bucket', async () => {
  const fetchImpl = stubFetch(async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl, timeoutMs: 25 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.status, 0);
  assert.equal(result.timeoutMs, 25);
  assert.match(describeUnreachableAttachment(URL_UNDER_TEST, result), /25ms/);
});

test('a DNS or TLS failure is reported as a network problem', async () => {
  const fetchImpl = stubFetch(async () => { throw new Error('getaddrinfo ENOTFOUND receipts.example.invalid'); });
  const result = await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
  assert.match(result.error, /ENOTFOUND/);
  assert.match(describeUnreachableAttachment(URL_UNDER_TEST, result), /could not be reached/i);
});

test('a probe with no URL fails closed instead of waving the send through', async () => {
  const fetchImpl = stubFetch(() => statusResponse(200));
  const result = await checkAttachmentReachable('', { fetchImpl });

  assert.equal(result.ok, false, 'an empty attachment URL must never be treated as reachable');
  assert.equal(fetchImpl.calls.length, 0);
});

test('redirects are followed so a CDN redirect is not read as a refusal', async () => {
  const fetchImpl = stubFetch(() => statusResponse(200));
  await checkAttachmentReachable(URL_UNDER_TEST, { fetchImpl });
  assert.equal(fetchImpl.calls[0].redirect, 'follow');
});