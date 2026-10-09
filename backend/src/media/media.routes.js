import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { downloadMedia } from '../lib/whatsapp/client.js';
import { getConversationById } from '../conversations/conversation.repository.js';
import { findMessageByMediaId } from '../conversations/message.repository.js';

export const mediaRouter = Router();

mediaRouter.use(authenticate);

const mediaParam = z.object({ mediaId: z.string().trim().min(4).max(512) });

/**
 * Streams inbound media on the API's own origin so the browser never sees the
 * Meta access token. Access is checked against the owning conversation, so an
 * agent cannot pull another agent's customer's attachments by guessing ids.
 */
mediaRouter.get(
  '/:mediaId',
  asyncRoute(async (req, res) => {
    const { mediaId } = mediaParam.parse(req.params);

    const message = await findMessageByMediaId(mediaId);
    if (!message) throw new HttpError(404, 'Media not found');

    const conversation = await getConversationById(message.conversation_id);
    if (!conversation) throw new HttpError(404, 'Media not found');

    if (req.staff.role !== 'admin' && conversation.assigned_staff_id !== req.staff.id) {
      throw new HttpError(403, 'This conversation is assigned to another staff member');
    }

    const { buffer, mimeType } = await downloadMedia(mediaId);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  })
);