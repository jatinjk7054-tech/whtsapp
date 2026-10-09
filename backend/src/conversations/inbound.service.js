import { parseWebhookPayload } from '../lib/whatsapp/parse.js';
import { config } from '../config.js';
import { sendTextMessage } from '../lib/whatsapp/client.js';
import { maybeSendAwayMessage } from '../away/away.service.js';
import { runAutomationForInbound } from '../automation/automation.service.js';
import {
  getOrCreateOpenConversation,
  touchConversation,
} from './conversation.repository.js';
import {
  applyProviderStatus,
  confirmOutboundMessage,
  failOutboundMessage,
  findMessageIdByWaMessageId,
  insertInboundMessage,
  insertOutboundMessage,
  recordWebhookEvent,
} from './message.repository.js';

function previewFor(message) {
  if (message.body) return message.body;
  if (message.mediaUrl) return `[${message.type}]`;
  return `[${message.type}]`;
}

/**
 * Handles one inbound customer message. The `webhook_events` insert is the
 * idempotency gate: Meta retries a webhook until it gets a 200, so the same
 * wamid can arrive several times.
 */
async function handleInbound(raw) {
  if (!(await recordWebhookEvent(raw.waMessageId, raw))) return { skipped: true };

  const conversation = await getOrCreateOpenConversation(raw.waId, raw.profileName);

  // WhatsApp reply context: the customer quoted one of our (or their) messages.
  // The raw wamid is always preserved; the local row is linked when we have it.
  const replyToId = await findMessageIdByWaMessageId(raw.contextMessageId);

  const inserted = await insertInboundMessage({
    conversationId: conversation.id,
    waMessageId: raw.waMessageId,
    type: raw.type,
    body: raw.body,
    mediaUrl: raw.mediaUrl,
    replyToId,
    replyToWaMessageId: raw.contextMessageId ?? null,
  });

  // Null means the unique index on wa_message_id rejected a duplicate.
  if (!inserted) return { skipped: true };

  await touchConversation(conversation.id, previewFor(raw));

  // Module 6 — automatic Away Message.
  //
  // handleInbound() is the ONLY caller: it runs for genuine customer messages
  // arriving through the webhook, never for agent/admin sends, template sends
  // or delivery/read/failed status updates (those go through handleStatus), and
  // never for our own away messages (they are direction = 'outbound'), so no
  // reply loop can form. It reads the Admin configuration from the database,
  // respects the office-hours schedule and the 24-hour per-customer cooldown,
  // and sends through the same Cloud API client as every other CRM message.
  const away = await maybeSendAwayMessage(conversation, { triggerMessageId: inserted.id });

  // Module 9 — keyword-based automatic replies. This also lives only on the
  // inbound path, so no reply can trigger another reply. It reads the Admin
  // rules, respects the per-rule cooldown / duplicate guards and the 24-hour
  // window, and never touches conversation assignment. When an Away Message
  // already went out for this message the default guard skips keywords unless
  // the Admin explicitly enabled both.
  const automation = await runAutomationForInbound(
    conversation,
    { id: inserted.id, body: raw.body },
    { awaySent: away.sent }
  );

  // The legacy first-contact greeting stays exactly as it was. It now also
  // stands down when a keyword rule replied, so a customer never receives two
  // automated replies at once from any combination of the three engines.
  if (!away.sent && !automation.sent && config.whatsapp.autoReplyEnabled && conversation.isNewConversation) {
    const autoReplyId = await insertOutboundMessage({
      conversationId: conversation.id,
      sentByStaffId: null,
      type: 'text',
      body: config.whatsapp.autoReplyText,
      mediaUrl: null,
    });

    try {
      const response = await sendTextMessage({
        to: conversation.contact_wa_id,
        body: config.whatsapp.autoReplyText,
      });
      await confirmOutboundMessage(autoReplyId, response.messages?.[0]?.id ?? null);
      await touchConversation(conversation.id, config.whatsapp.autoReplyText);
    } catch (error) {
      await failOutboundMessage(autoReplyId, error.code, error.message);
      console.error('Automatic WhatsApp reply failed:', error.message);
    }
  }

  return { conversationId: conversation.id, messageId: inserted.id };
}

async function handleStatus(raw) {
  const updated = await applyProviderStatus(
    raw.waMessageId,
    raw.status,
    raw.errorCode,
    raw.errorDetail
  );

  return { updated: Boolean(updated) };
}

/**
 * Serialised through an in-process chain so Meta's redeliveries interleave
 * cleanly with our own writes. Swap this module for a real queue (SQS, BullMQ)
 * if you ever run more than one API instance.
 */
let queue = Promise.resolve();

export function ingestWebhookPayload(payload) {
  const { inbound, statuses } = parseWebhookPayload(payload);

  const work = queue.then(async () => {
    const summary = { inbound: 0, statuses: 0, failed: 0 };

    for (const raw of inbound) {
      try {
        const result = await handleInbound(raw);
        if (!result.skipped) summary.inbound += 1;
      } catch (error) {
        summary.failed += 1;
        console.error('Failed to ingest inbound message', raw.waMessageId, error.message);
      }
    }

    for (const raw of statuses) {
      try {
        const result = await handleStatus(raw);
        if (result.updated) summary.statuses += 1;
      } catch (error) {
        summary.failed += 1;
        console.error('Failed to apply status update', raw.waMessageId, error.message);
      }
    }

    return summary;
  });

  // Keep the chain alive even if this link rejects, so one bad event cannot
  // wedge every future webhook.
  queue = work.catch(() => {});

  return work;
}

export function whenIngestIdle() {
  return queue;
}