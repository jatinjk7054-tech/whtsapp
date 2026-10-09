import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { computeSignature } from '../lib/whatsapp/signature.js';

/**
 * Meta signs the raw request body with the app secret and sends the digest in
 * X-Hub-Signature-256. Verifying it is the only thing that stops anyone who
 * learned the webhook URL from injecting fake customer messages.
 */
export function verifyWebhookSignature(req, res, next) {
  // LOCAL DEVELOPMENT ONLY — WhatsApp App Secret verification bypass.
  //
  // Local dev may not have WHATSAPP_APP_SECRET filled in, and without a secret
  // there is nothing to verify against, so development lets the request through
  // to keep local webhook testing possible. This branch is reachable only when
  // NODE_ENV === 'development' AND the secret is unset: production (or any
  // other env) with a missing secret still takes the hard 503 below, and any
  // environment that has a secret always runs full signature verification.
  const localDevBypass = config.env === 'development' && !config.whatsapp.appSecret;

  if (!config.whatsapp.appSecret) {
    if (localDevBypass) {
      return next();
    }

    console.warn(
      'WHATSAPP WEBHOOK REJECTED: signature verification disabled (no WHATSAPP_APP_SECRET)',
      JSON.stringify({ method: req.method, path: req.originalUrl })
    );

    return res.status(503).json({
      error: 'webhook_signature_verification_disabled',
      message: 'Set WHATSAPP_APP_SECRET to enable signature verification.',
    });
  }

  const header = req.get('x-hub-signature-256') ?? '';
  const [scheme, provided] = header.split('=');

  if (scheme !== 'sha256' || !provided) {
    console.warn(
      'WHATSAPP WEBHOOK REJECTED: missing/invalid X-Hub-Signature-256 header',
      JSON.stringify({ method: req.method, path: req.originalUrl, hasHeader: Boolean(header) })
    );
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const expected = computeSignature(req.rawBody, config.whatsapp.appSecret);
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    console.warn(
      'WHATSAPP WEBHOOK REJECTED: signature mismatch (check WHATSAPP_APP_SECRET matches the Meta App)',
      JSON.stringify({ method: req.method, path: req.originalUrl })
    );
    return res.status(401).json({ error: 'invalid_signature' });
  }

  return next();
}