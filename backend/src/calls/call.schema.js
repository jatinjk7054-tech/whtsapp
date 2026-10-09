import { z } from 'zod';

/**
 * Module 12 — request shapes for the calling API. SDP blobs are validated only
 * for size/presence here; the browser produced them and Meta validates them.
 */
export const callIdParam = z.object({ id: z.coerce.number().int().positive() });

export const conversationIdParam = z.object({
  id: z.coerce.number().int().positive(),
});

// Generous upper bound: an SDP answer with ICE candidates is a few KB.
const sdp = z.string().trim().min(1).max(64_000);

export const startCallBody = z.object({ sdpOffer: sdp });

export const answerCallBody = z.object({ sdpAnswer: sdp });

export const listCallsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
