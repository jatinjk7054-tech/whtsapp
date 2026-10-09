import { createHmac } from 'node:crypto';

/**
 * Returns the hex digest of the raw request body, i.e. the part of the
 * X-Hub-Signature-256 header that follows the "sha256=" scheme.
 */
export function computeSignature(rawBody, appSecret) {
  return createHmac('sha256', appSecret).update(rawBody ?? Buffer.alloc(0)).digest('hex');
}