import path from 'node:path';

const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker']);

function toIsoTimestamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function summarize(type, value) {
  switch (type) {
    case 'text':
      return value.text?.body ?? '';
    case 'button':
      return value.button?.text ?? value.button?.payload ?? '[button]';
    case 'interactive': {
      const interactive = value.interactive ?? {};
      if (interactive.button_reply?.title) return interactive.button_reply.title;
      if (interactive.list_reply?.title) return interactive.list_reply.title;
      return '[interactive reply]';
    }
    case 'location':
      return value.location
        ? `[location] ${value.location.latitude}, ${value.location.longitude}`
        : '[location]';
    case 'reaction':
      return `[reaction] ${value.reaction?.emoji ?? ''}`.trim();
    case 'contacts':
      return '[contact card]';
    case 'order':
      return '[order]';
    case 'system':
      return value.system?.body ?? '[system]';
    case 'unsupported':
      return '[unsupported message]';
    default:
      return `[${type}]`;
  }
}

function normalizeMessage(raw) {
  const type = raw.type ?? 'unknown';
  const media = MEDIA_TYPES.has(type) ? raw[type] ?? null : null;

  return {
    waId: raw.from,
    waMessageId: raw.id,
    timestamp: toIsoTimestamp(raw.timestamp),
    type,
    body: summarize(type, raw),
    // Media bytes are only fetchable with our access token, so we hand the UI
    // a proxied path instead of the raw Meta URL.
    mediaUrl: media?.id ? path.posix.join('/api/media', media.id) : null,
    caption: media?.caption ?? null,
    mimeType: media?.mime_type ?? null,
    contextMessageId: raw.context?.id ?? null,
  };
}

function normalizeStatus(raw) {
  return {
    waMessageId: raw.id,
    status: raw.status,
    timestamp: toIsoTimestamp(raw.timestamp),
    recipientId: raw.recipient_id ?? null,
    errorCode: raw.errors?.[0]?.code ?? null,
    errorDetail: raw.errors?.[0]?.title ?? null,
  };
}

/**
 * Flattens Meta's nested entry[].changes[].value envelope into the two things
 * we actually care about: inbound customer messages and delivery status updates.
 */
export function parseWebhookPayload(payload) {
  const inbound = [];
  const statuses = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change.field !== 'messages') continue;

      const value = change.value ?? {};
      const profileNameByWaId = new Map(
        (value.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name ?? ''])
      );

      for (const raw of value.messages ?? []) {
        const normalized = normalizeMessage(raw);
        if (!normalized.waId || !normalized.waMessageId) continue;
        normalized.profileName = profileNameByWaId.get(normalized.waId) ?? '';
        inbound.push(normalized);
      }

      for (const raw of value.statuses ?? []) {
        if (!raw?.id) continue;
        statuses.push(normalizeStatus(raw));
      }
    }
  }

  return { inbound, statuses };
}