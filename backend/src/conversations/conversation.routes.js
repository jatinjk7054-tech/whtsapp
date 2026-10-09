import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  sendReply,
  sendUploadedMedia,
  forwardMessage,
  retryOutboundMessage,
} from './outbound.service.js';
import {
  assign,
  claim,
  getThread,
  getStatusHistory,
  listInbox,
  searchMessagesForStaff,
  setStatus,
  unassign,
  createConversationForOutbound,
} from './conversation.service.js';
import * as callService from '../calls/call.service.js';
import { startCallBody } from '../calls/call.schema.js';

export const conversationRouter = Router();

conversationRouter.use(authenticate);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  view: z.enum(['mine', 'unassigned', 'all', 'unread']).optional(),
  assignedStaffId: z.coerce.number().int().positive().optional(),
  status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  // Module 5: comma-separated tag ids, e.g. ?tags=2,4 — ANY match wins.
  tags: z.string().trim().max(400).optional(),
  sort: z.enum(['recent', 'oldest']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const threadQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
  markRead: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const statusBody = z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']) });

const contactBody = z.object({
  waId: z.string().trim().min(8).max(20),
  name: z.string().trim().max(120).optional(),
});

const assignBody = z.object({
  assignedStaffId: z.coerce.number().int().positive().nullable(),
});

// `discriminatedUnion` cannot host a defaulted discriminator, so `type` is
// filled in before validation rather than inside the text branch.
const sendBody = z.preprocess(
  (input) => {
    const value = input ?? {};
    return typeof value.type === 'string' ? value : { ...value, type: 'text' };
  },
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      body: z.string().trim().min(1).max(4096),
      replyToId: z.coerce.number().int().positive().optional(),
    }),
    z.object({
      type: z.enum(['image', 'audio', 'video', 'document', 'sticker']),
      mediaUrl: z.string().url(),
      body: z.string().trim().max(1024).optional(),
      replyToId: z.coerce.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal('template'),
      name: z.string().trim().min(1).max(512),
      language: z.string().trim().min(1).max(32),
      // Meta-shaped components stay supported (advanced callers); the Template
      // Library sends the simpler field set below and the backend builds the
      // exact Meta payload from the approved definition.
      components: z.array(z.any()).optional(),
      variables: z.array(z.string().max(2000)).max(30).optional(),
      headerVariables: z.array(z.string().max(2000)).max(10).optional(),
      headerMedia: z
        .object({
          type: z.enum(['image', 'video', 'document']),
          url: z.string().url().max(2048).optional(),
          base64: z.string().min(1).max(22_000_000).optional(),
          filename: z.string().trim().max(255).optional(),
          mimeType: z.string().trim().max(200).optional(),
        })
        .optional(),
      buttonParams: z
        .array(
          z.object({
            index: z.coerce.number().int().min(0).max(19),
            value: z.string().trim().min(1).max(2000),
          })
        )
        .max(10)
        .optional(),
    }),
  ])
);

const forwardBody = z.object({
  sourceMessageId: z.coerce.number().int().positive(),
});

const messageSearchQuery = z.object({
  search: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// Registered before GET /:id for readability; the paths never collide
// (`/messages/search` has two segments, `/:id` one).
conversationRouter.get(
  '/messages/search',
  asyncRoute(async (req, res) => {
    const { search, limit } = messageSearchQuery.parse(req.query);
    res.json({ items: await searchMessagesForStaff(req.staff, { search, limit }) });
  })
);

conversationRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json(await listInbox(req.staff, listQuery.parse(req.query)));
  })
);

conversationRouter.post(
  '/contact',
  asyncRoute(async (req, res) => {
    const { waId, name } = contactBody.parse(req.body);
    res.status(201).json(await createConversationForOutbound(req.staff, waId, name));
  })
);

conversationRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { markRead, ...pagination } = threadQuery.parse(req.query);
    res.json(await getThread(req.staff, id, { markRead, ...pagination }));
  })
);

conversationRouter.post(
  '/:id/claim',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await claim(req.staff, id));
  })
);

conversationRouter.put(
  '/:id/assign',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { assignedStaffId } = assignBody.parse(req.body);
    res.json(
      assignedStaffId === null
        ? await unassign(req.staff, id)
        : await assign(req.staff, id, assignedStaffId)
    );
  })
);

conversationRouter.patch(
  '/:id/status',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { status } = statusBody.parse(req.body);
    res.json(await setStatus(req.staff, id, status));
  })
);

/**
 * Module 7 §26 — audit trail of status moves. Same ownership rule as the thread.
 */
conversationRouter.get(
  '/:id/status-history',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await getStatusHistory(req.staff, id));
  })
);

// Module 12 — call history for a thread, plus the active call to resume after a
// refresh. Same ownership gate as every other conversation read.
conversationRouter.get(
  '/:id/calls',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await callService.listForConversation(req.staff, id));
  })
);

// Module 12 — place an outbound call. The body carries the browser's SDP offer;
// the response is the call row the UI polls for Meta's answer.
conversationRouter.post(
  '/:id/calls',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { sdpOffer } = startCallBody.parse(req.body);
    res.status(201).json(await callService.startOutbound(req.staff, id, { sdpOffer }));
  })
);

conversationRouter.post(
  '/:id/media',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const schema = z.object({
      type: z.enum(['image', 'document', 'video', 'audio']),
      filename: z.string().trim().max(255).optional(),
      mimeType: z.string().trim().max(200).optional(),
      base64: z.string().min(1).max(22_000_000),
      body: z.string().trim().max(1024).optional(),
    });
    res.status(201).json(await sendUploadedMedia(req.staff, id, schema.parse(req.body)));
  })
);

conversationRouter.post(
  '/:id/messages',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const parsed = sendBody.parse(req.body);
    const { type, body, mediaUrl, replyToId } = parsed;

    res.status(201).json(
      await sendReply(req.staff, id, {
        type,
        body,
        media: mediaUrl ? { link: mediaUrl } : undefined,
        template:
          type === 'template'
            ? {
                name: parsed.name,
                language: parsed.language,
                components: parsed.components,
                variables: parsed.variables,
                headerVariables: parsed.headerVariables,
                headerMedia: parsed.headerMedia,
                buttonParams: parsed.buttonParams,
              }
            : undefined,
        replyToId,
      })
    );
  })
);

// Module 11 — Retry a failed outgoing message. Same ownership gate as sending,
// and only a row the provider actually marked failed can be retried.
conversationRouter.post(
  '/:id/messages/:messageId/retry',
  asyncRoute(async (req, res) => {
    const { id, messageId } = z
      .object({
        id: z.coerce.number().int().positive(),
        messageId: z.coerce.number().int().positive(),
      })
      .parse(req.params);
    res.status(201).json(await retryOutboundMessage(req.staff, id, messageId));
  })
);

// Forward: re-sends an existing message to another conversation this staff
// member is allowed to reply to (see forwardMessage for the type handling).
conversationRouter.post(
  '/:id/forward',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { sourceMessageId } = forwardBody.parse(req.body);
    res.status(201).json(await forwardMessage(req.staff, id, sourceMessageId));
  })
);