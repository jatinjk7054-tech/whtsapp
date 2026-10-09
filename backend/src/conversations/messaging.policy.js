import { HttpError } from '../lib/HttpError.js';
import { query } from '../db/pool.js';

/**
 * Module 9 — the one implementation of WhatsApp's 24-hour customer-care window.
 *
 * A free-form message (text or media) may only be sent within 24 hours of the
 * customer's most recent inbound message; outside that window Meta requires an
 * approved template. Module 3 enforced this inside outbound.service.js; it now
 * lives here so the keyword-automation engine applies the exact same rule
 * instead of re-deriving it (and drifting from it).
 */

export const WINDOW_HOURS = 24;
export const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

/** Epoch milliseconds of the customer's most recent inbound message, or 0. */
export async function lastInboundAt(conversationId) {
  const result = await query(
    `SELECT MAX(created_at) AS created_at FROM messages WHERE conversation_id = $1 AND direction = 'inbound'`,
    [conversationId]
  );
  const at = result.rows[0]?.created_at;
  return at ? new Date(at).getTime() : 0;
}

/**
 * Non-throwing window snapshot. `open` is false when the customer has never
 * written or the last inbound is 24 hours old or older — the two cases Meta
 * both treat as "no open window".
 */
export async function windowState(conversationId, now = Date.now()) {
  const at = await lastInboundAt(conversationId);
  const open = Boolean(at) && now - at < WINDOW_MS;
  const expiresAt = at ? at + WINDOW_MS : 0;
  return {
    open,
    lastInboundAt: at || null,
    expiresAt: expiresAt || null,
    hoursRemaining: open ? (expiresAt - now) / (60 * 60 * 1000) : 0,
  };
}

/** Throwing variant used by the agent send / forward / upload paths. */
export async function assertWithin24hWindow(conversationId) {
  const state = await windowState(conversationId);
  if (!state.open) {
    throw new HttpError(
      409,
      'The 24-hour WhatsApp customer-care window is closed. Send an approved template instead.'
    );
  }
  return state;
}
