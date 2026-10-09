import { normalizeRole } from './authMiddleware.js';

/**
 * Community Chat access gates (plan.md §2.2).
 *
 * The important asymmetry: reads are gated on *data* (do you have a
 * chat_participants row?) and writes are gated on *role*. Gating reads on role
 * would lock the six read-only roles out of the Community room, which is the
 * whole point of the feature.
 *
 * A missing participant row is reported as 404, never 403, so a caller cannot
 * probe for the existence of a conversation they are not in.
 */

export const CHAT_ROLES = new Set(['super_admin', 'accounts']);

/** True when this identity may post messages and open DMs. */
export const isWriterRole = (role) => CHAT_ROLES.has(normalizeRole(role));

/**
 * Write gate. Must mount AFTER `authenticate` so req.user is populated.
 *
 * This is the only place posting rights are decided. `chat_participants.can_post`
 * is a cached copy for the UI's benefit and is deliberately NOT trusted here, so
 * a stale or hand-edited row cannot grant posting.
 */
export const chatWriter = (req, res, next) =>
  isWriterRole(req.user?.role)
    ? next()
    : res.status(403).json({ message: 'Only Super Admin and Accounts can post in chat.' });

export const notFound = (res) =>
  res.status(404).json({ message: 'Conversation not found' });
