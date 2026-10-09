import { HttpError } from '../lib/HttpError.js';
import { sendTextMessage } from '../lib/whatsapp/client.js';
import { getConversationById, touchConversation } from './conversation.repository.js';
import { assertWithin24hWindow } from './messaging.policy.js';
import { sendTemplateMessage, uploadMedia, sendMediaMessage, downloadMedia } from '../lib/whatsapp/client.js';
import { prepareTemplateSend } from './template.service.js';
import {
  attachOutboundMedia,
  confirmOutboundMessage,
  failOutboundMessage,
  findMessageById,
  findRetryableMessage,
  insertOutboundMessage,
  resetOutboundForRetry,
} from './message.repository.js';

const MAX_TEXT_LENGTH = 4096;
const FORWARDED_TYPES = new Set(['text', 'image', 'video', 'document', 'audio']);

export function assertSendable(staff, conversation) {
  if (staff.role !== 'admin' && conversation.assigned_staff_id !== staff.id) {
    throw new HttpError(403, 'Claim this conversation before replying to it');
  }
  if (conversation.status === 'closed') {
    throw new HttpError(409, 'This conversation is closed. Reopen it before sending.');
  }
}

async function dispatch(conversation, message) {
  try {
    const payload =
      message.type === 'template'
        ? await sendTemplateMessage({ to: conversation.contact_wa_id, template: message.template })
        : message.type === 'text'
          ? await sendTextMessage({
              to: conversation.contact_wa_id,
              body: message.body,
              contextMessageId: message.contextMessageId,
            })
          : await sendMediaMessage({
              to: conversation.contact_wa_id,
              type: message.type,
              media: message.media,
              contextMessageId: message.contextMessageId,
            });

    return confirmOutboundMessage(message.id, payload.messages?.[0]?.id ?? null);
  } catch (error) {
    await failOutboundMessage(message.id, error.code, error.message);
    throw error;
  }
}

/**
 * Writes the message first, then hands it to Meta. That ordering means the
 * agent's reply is visible in their own UI immediately (and survives a Meta
 * outage as a `failed` row) instead of vanishing when the API call throws.
 * `replyToId` (optional) links the quoted original locally and — when the
 * original has a wamid — sends Meta's `context.message_id` so WhatsApp shows
 * the quoted thread on the customer's phone too.
 */
export async function sendReply(staff, conversationId, { body, type = 'text', media, template, replyToId } = {}) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found');

  assertSendable(staff, conversation);

  let original = null;
  let prepared = null;
  if (replyToId) {
    original = await findMessageById(replyToId);
    if (!original || original.conversation_id !== conversationId) {
      throw new HttpError(422, 'The message being replied to was not found in this conversation');
    }
  }

  if (type === 'text') {
    if (!body?.trim()) throw new HttpError(422, 'Message body is required');
    if (body.length > MAX_TEXT_LENGTH) throw new HttpError(422, `Message body must be ${MAX_TEXT_LENGTH} characters or fewer`);
    await assertWithin24hWindow(conversationId);
  }
  if (type === 'template') {
    if (!template?.name || !template?.language) throw new HttpError(422, 'Template name and language are required');
    // Module 4: only a template Meta reports as APPROVED for this exact language
    // is allowed, and every variable/header/button value is validated here —
    // before the row is written — so an invalid payload never reaches Meta.
    prepared = await prepareTemplateSend(template);
    // Templates are not replies — Meta rejects a context on template sends.
    original = null;
  }

  const templateBody = type === 'template' ? (prepared?.body || `[Template] ${template.name}`) : null;

  const messageId = await insertOutboundMessage({
    conversationId,
    sentByStaffId: staff.id,
    type,
    body: type === 'template' ? templateBody : (body ?? ''),
    mediaUrl: media?.url ?? prepared?.params?.header?.mediaPath ?? null,
    replyToId: original?.id ?? null,
    templateName: type === 'template' ? template.name : null,
    templateLanguage: type === 'template' ? template.language : null,
    templateParams: type === 'template' ? (prepared?.params ?? null) : null,
  });

  const confirmed = await dispatch(conversation, {
    id: messageId,
    type,
    body,
    media,
    template: type === 'template'
      ? { name: template.name, language: template.language, components: prepared?.components }
      : undefined,
    contextMessageId: original?.wa_message_id ?? undefined,
  });

  await touchConversation(conversationId, type === 'template' ? templateBody : (body ?? `[${type}]`));

  return {
    id: messageId,
    status: 'sent',
    waMessageId: confirmed?.wa_message_id ?? null,
  };
}

export async function sendUploadedMedia(staff, conversationId, { type, filename, mimeType, base64, body = '' }) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  assertSendable(staff, conversation);
  await assertWithin24hWindow(conversationId);
  if (!['image', 'document', 'video', 'audio'].includes(type)) throw new HttpError(422, 'Unsupported attachment type');
  const clean = String(base64 ?? '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new HttpError(422, 'Attachment must be between 1 byte and 15 MB');
  const uploaded = await uploadMedia(buffer, mimeType || 'application/octet-stream', filename || 'upload');
  const messageId = await insertOutboundMessage({
    conversationId, sentByStaffId: staff.id, type, body: body || `[${type}]`, mediaUrl: null,
  });
  if (uploaded?.id) await attachOutboundMedia(messageId, `/api/media/${uploaded.id}`);
  try {
    const payload = await sendMediaMessage({ to: conversation.contact_wa_id, type, media: { id: uploaded.id } });
    const confirmed = await confirmOutboundMessage(messageId, payload.messages?.[0]?.id ?? null);
    await touchConversation(conversationId, body || `[${type}]`);
    return { id: messageId, status: 'sent', waMessageId: confirmed?.wa_message_id ?? null };
  } catch (error) {
    await failOutboundMessage(messageId, error.code, error.message);
    throw error;
  }
}

const MEDIA_EXT = { image: 'jpg', video: 'mp4', audio: 'mp3', document: 'bin' };

/**
 * Module 3 — Forward. The Cloud API has no native forward call, so the message
 * is genuinely re-sent to the target customer through the same flow WhatsApp
 * sends use: text goes straight out; media is pulled from Meta with our token,
 * re-uploaded with our token and sent by id. Tokens never leave the backend.
 * Returns a normal outbound message flagged `is_forwarded` (our own UI shows
 * the "Forwarded" label — nothing is faked towards Meta).
 */
export async function forwardMessage(staff, targetConversationId, sourceMessageId) {
  const target = await getConversationById(targetConversationId);
  if (!target) throw new HttpError(404, 'Conversation not found');
  assertSendable(staff, target);

  const source = await findMessageById(sourceMessageId);
  if (!source) throw new HttpError(404, 'Message not found');

  const sourceConversation = await getConversationById(source.conversation_id);
  if (!sourceConversation) throw new HttpError(404, 'Message not found');
  if (staff.role !== 'admin' && sourceConversation.assigned_staff_id !== staff.id) {
    throw new HttpError(403, "You cannot forward a message from another staff member's conversation");
  }

  if (!FORWARDED_TYPES.has(source.type)) {
    throw new HttpError(422, source.type === 'template' ? 'Template messages cannot be forwarded. Send the content directly instead.' : 'This message type cannot be forwarded. Send the content directly instead.');
  }
  if (source.type !== 'text' && !source.media_url) {
    throw new HttpError(422, 'This message has no downloadable media to forward');
  }

  await assertWithin24hWindow(targetConversationId);

  if (source.type === 'text') {
    const messageId = await insertOutboundMessage({
      conversationId: targetConversationId,
      sentByStaffId: staff.id,
      type: 'text',
      body: source.body,
      mediaUrl: null,
      isForwarded: true,
    });
    const confirmed = await dispatch(target, { id: messageId, type: 'text', body: source.body });
    await touchConversation(targetConversationId, source.body);
    return { id: messageId, status: 'sent', waMessageId: confirmed?.wa_message_id ?? null };
  }

  const mediaMatch = /^\/api\/media\/(.+)$/.exec(source.media_url);
  if (!mediaMatch) throw new HttpError(422, 'This message has no downloadable media to forward');

  let uploaded;
  try {
    const { buffer, mimeType } = await downloadMedia(mediaMatch[1]);
    const extension = MEDIA_EXT[source.type] ?? 'bin';
    uploaded = await uploadMedia(buffer, mimeType, `forwarded-${source.id}.${extension}`);
  } catch {
    // Meta purges media after a while. Say so instead of sending something fake.
    throw new HttpError(422, 'This media is no longer available on WhatsApp and cannot be forwarded');
  }
  if (!uploaded?.id) throw new HttpError(422, 'This media could not be forwarded');

  const placeholder = `[${source.type}]`;
  const caption = source.body && source.body !== placeholder ? source.body : '';

  const messageId = await insertOutboundMessage({
    conversationId: targetConversationId,
    sentByStaffId: staff.id,
    type: source.type,
    body: caption || placeholder,
    mediaUrl: null,
    isForwarded: true,
  });
  await attachOutboundMedia(messageId, `/api/media/${uploaded.id}`);

  try {
    const payload = await sendMediaMessage({ to: target.contact_wa_id, type: source.type, media: { id: uploaded.id } });
    const confirmed = await confirmOutboundMessage(messageId, payload.messages?.[0]?.id ?? null);
    await touchConversation(targetConversationId, caption || placeholder);
    return { id: messageId, status: 'sent', waMessageId: confirmed?.wa_message_id ?? null };
  } catch (error) {
    await failOutboundMessage(messageId, error.code, error.message);
    throw error;
  }
}

/** Rebuilds the Meta send arguments for a failed row so Retry can reuse it. */
async function prepareRetry(conversation, message) {
  const contextMessageId = message.reply_to_id
    ? (await findMessageById(message.reply_to_id))?.wa_message_id ?? undefined
    : undefined;

  if (message.type === 'template') {
    const params = message.template_params ?? {};
    const header = params.header;

    let headerMedia;
    if (header?.type && header.url) {
      headerMedia = { type: header.type, url: header.url };
    } else if (header?.type && header.mediaPath) {
      const match = /^\/api\/media\/(.+)$/.exec(header.mediaPath);
      if (match) {
        const { buffer, mimeType } = await downloadMedia(match[1]);
        headerMedia = { type: header.type, base64: buffer.toString('base64'), mimeType };
      }
    }

    const prepared = await prepareTemplateSend({
      name: message.template_name,
      language: message.template_language,
      variables: params.variables,
      headerVariables: params.headerVariables,
      headerMedia,
      buttonParams: params.buttonParams,
    });

    return {
      type: 'template',
      body: message.body,
      template: {
        name: message.template_name,
        language: message.template_language,
        components: prepared.components,
      },
    };
  }

  await assertWithin24hWindow(conversation.id);

  if (message.type === 'text') {
    return { type: 'text', body: message.body, contextMessageId };
  }

  const mediaUrl = message.media_url ?? '';
  const mediaMatch = /^\/api\/media\/(.+)$/.exec(mediaUrl);
  const media = mediaMatch ? { id: mediaMatch[1] } : { link: mediaUrl };

  return { type: message.type, body: message.body, media, contextMessageId };
}

/**
 * Module 11 — Retry a failed outgoing message. Only the caller's own (or, for an
 * admin, any) conversation can be retried, and only a row still marked `failed`.
 * The same row, wamid slot and bubble are reused — nothing is duplicated.
 */
export async function retryOutboundMessage(staff, conversationId, messageId) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  assertSendable(staff, conversation);

  const message = await findRetryableMessage(messageId);
  if (!message || message.conversation_id !== conversationId) {
    throw new HttpError(404, 'Message not found');
  }
  if (message.direction !== 'outbound') {
    throw new HttpError(422, 'Only outgoing messages can be retried');
  }
  if (message.status !== 'failed') {
    throw new HttpError(409, 'Only failed messages can be retried');
  }

  const args = await prepareRetry(conversation, message);

  await resetOutboundForRetry(messageId);

  const confirmed = await dispatch(conversation, { id: messageId, ...args });
  await touchConversation(conversationId, message.body || `[${message.type}]`);

  return { id: messageId, status: 'sent', waMessageId: confirmed?.wa_message_id ?? null };
}
