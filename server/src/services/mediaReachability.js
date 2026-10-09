// Guards the one WhatsApp send step we cannot observe synchronously.
//
// Meta's POST /{phone_number_id}/messages answers 200 with a wamid the instant
// it accepts a template send. It has not touched the attachment yet. A minute
// later it fetches the HEADER document from the URL we handed it, and if that
// fetch fails the whole message dies with error 131053 ("Media upload error",
// typically "Downloading media from weblink failed with http code 403"). By
// then the API has already told the Accounts panel "sent successfully" and the
// receipt has been struck off the pending queue.
//
// The only way to catch that class of failure before it costs a donor their
// receipt is to make the same anonymous request Meta is about to make, ourselves,
// and refuse to send when the answer is not 200. That is all this module does.

const DEFAULT_TIMEOUT_MS = 8000;

// S3 answers HEAD for a public object and 403 for a private one without
// transferring the body, so HEAD is the cheap first probe. Not every storage
// frontend implements HEAD, so a 405/501 falls back to a ranged GET rather than
// being reported as a broken attachment.
const PROBE_ATTEMPTS = [
  { method: 'HEAD' },
  { method: 'GET', headers: { Range: 'bytes=0-0' } },
];

// A SigV4 presigned URL carries its authorization in the query string, and the
// HTTP method is part of what it signs. So S3 answers 403 to a HEAD of a URL that
// returns the object perfectly well to a GET -- verified against the live
// bucket: HEAD 403, ranged GET 206, plain GET 200 with all 124105 bytes.
//
// That combination is fatal here, because the 403 from the HEAD probe used to end
// the check before the ranged GET was ever tried, so a completely healthy receipt
// was refused and the operator was told the bucket needed to be made world
// readable -- the opposite of the fix, and a step that would expose every donor
// PAN and address in it.
//
// So a presigned URL is only ever probed with GET, which is also what Meta does.
export function isPresignedAttachment(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.searchParams.has('X-Amz-Signature') && parsed.searchParams.has('X-Amz-Credential');
}

function probeAttemptsFor(url) {
  return isPresignedAttachment(url)
    ? [PROBE_ATTEMPTS[1]]
    : PROBE_ATTEMPTS;
}

const isHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value < 600;

export function describeUnreachableAttachment(url, result) {
  const host = (() => {
    try { return new URL(url).host; } catch { return url; }
  })();
  const where = `${host} answered HTTP ${result.status}`;
  if (isPresignedAttachment(url) && (result.status === 403 || result.status === 401)) {
    // Not a permissions problem on the bucket. The signature in the URL was
    // rejected, which in practice means it expired or was signed with a key the
    // bucket no longer accepts. Saying "grant public access" here would be both
    // wrong and dangerous.
    return (
      `The receipt PDF's signed download link was rejected (${where}). ` +
      `The link is self-authorised, so the object is readable and the bucket does ` +
      `not need to be made public -- do not add a public bucket policy. This link ` +
      `had most likely expired: it is generated per send, so re-send the receipt. ` +
      `If it keeps happening, the signing credentials no longer match the bucket.`
    );
  }
  if (result.status === 403 || result.status === 401) {
    // The URL Meta was handed carried no authorisation at all: no X-Amz-Signature,
    // no signed proxy token, just a bare bucket path. A private bucket refuses
    // exactly that, so the 403 is the bucket working as intended and says nothing
    // about its policy.
    //
    // This branch used to tell the operator to grant s3:GetObject to Principal
    // "*". That is wrong twice over: the bucket is meant to stay private, and
    // following the instruction would have published every donor PAN, address and
    // amount in it. It also sent a real investigation off to fix AWS instead of
    // the link-issuing path that actually dropped the credential.
    return (
      `WhatsApp was given a bare bucket URL with no credential in it, and the ` +
      `bucket correctly refused the anonymous read (${where}). This is not a ` +
      `donor or template problem, and the fix is NOT to grant s3:GetObject to ` +
      `Principal "*" -- the receipts bucket is meant to stay private, and doing ` +
      `that would expose every donor PAN, address and amount already in it. A ` +
      `receipt link must be an S3 presigned URL or a signed ` +
      `/api/whatsapp/receipt-file link, both of which carry their own ` +
      `authorisation. This URL carried neither, so the link-issuing path did not ` +
      `run and the send should have been refused rather than attempted.`
    );
  }
  if (result.status === 404) {
    return (
      `The receipt PDF is not at the URL WhatsApp will be given (${where}). ` +
      `The upload reported success but the object cannot be read back.`
    );
  }
  if (result.status === 405 || result.status === 501) {
    return `The receipt host does not support a read probe (${where}).`;
  }
  if (result.reason === 'timeout') {
    return `The receipt host did not respond within ${result.timeoutMs}ms (${url}). WhatsApp would time out on it too.`;
  }
  if (result.reason === 'network') {
    return `The receipt host could not be reached (${result.error || 'network error'}). WhatsApp would fail on it too.`;
  }
  return `The receipt PDF could not be verified as downloadable by WhatsApp (${where}).`;
}

/**
 * Probes `url` exactly the way Meta will, and reports whether it is safe to send.
 *
 * Never throws: every failure mode is reported in the returned object so the
 * caller decides whether an unreachable attachment is fatal. Returns
 * `{ ok: true, status, method }` or `{ ok: false, status, statusText, method,
 * reason, error, timeoutMs, url }`.
 */
export async function checkAttachmentReachable(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = options;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, url, reason: 'network', error: 'fetch is unavailable in this runtime', timeoutMs };
  }
  if (!url || typeof url !== 'string') {
    return { ok: false, url, reason: 'network', error: 'no attachment URL to probe', timeoutMs };
  }

  let last = null;
  for (const attempt of probeAttemptsFor(url)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: attempt.method,
        headers: attempt.headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      if (isHttpStatus(res.status) && res.status >= 200 && res.status < 300) {
        return { ok: true, url, status: res.status, method: attempt.method };
      }
      // 206 is what a ranged GET returns for a healthy object; it is already
      // covered by the 2xx branch above, so anything here is a real refusal.
      last = {
        ok: false, url, status: res.status, statusText: res.statusText || '',
        method: attempt.method, reason: 'http', timeoutMs,
      };
      // A hard refusal is not retried with another verb: if the bucket or origin
      // denied this read, changing the verb cannot turn that into a 2xx. Only a
      // "this verb is not implemented" answer is worth retrying as a GET. The
      // verb-sensitive presigned case is handled before this loop, by probing
      // those URLs with GET to begin with.
      if (res.status !== 405 && res.status !== 501) return last;
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      last = {
        ok: false, url, status: 0, statusText: '', method: attempt.method,
        reason: aborted ? 'timeout' : 'network', error: err?.message || String(err), timeoutMs,
      };
      // A timeout or a dead host will not be fixed by changing the verb.
      return last;
    } finally {
      clearTimeout(timer);
    }
  }
  return last || { ok: false, url, status: 0, reason: 'network', error: 'probe failed', timeoutMs };
}
