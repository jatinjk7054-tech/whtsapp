import { parseWebhookPayload } from '../lib/whatsapp/parse.js';
import { config } from '../config.js';
import { sendTextMessage } from '../lib/whatsapp/client.js';
import { maybeSendAwayMessage } from '../away/away.service.js';
import { runAutomationForInbound } from '../automation/automation.service.js';
import { notifyInboundMessage } from '../notifications/notification.service.js';
import { handleCallEvent, handleCallStatus } from '../calls/call.service.js';
import {
  getOrCreateOpenConversation,
  touchConversation,
} from './conversation.repository.js';
import {
  applyStatusEvent,
  confirmOutboundMessage,
  failOutboundMessage,
  findMessageIdByWaMessageId,
  insertInboundMessage,
  insertOutboundMessage,
  reconcileStatusEvents,
  recordStatusEvent,
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

  // Module 10 — notify eligible staff (the conversation's owner, or the admins
  // when it is unassigned) about the new message. Wrapped so a notification
  // problem can never lose a customer message; the dedupe index absorbs any
  // retry, and NOTHING here changes assignment.
  try {
    await notifyInboundMessage(conversation, { id: inserted.id, body: raw.body, type: raw.type });
  } catch (error) {
    console.error('Failed to create notification:', error.message);
  }

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

/**
 * Module 11 — one delivery/read receipt. The event is persisted first (deduped
 * on wamid + status + timestamp) so a receipt that arrives before its message
 * row exists is not lost; applyStatusEvent() then moves the message forward.
 * Unmatched events are picked up later by reconcileStatusEvents().
 */
async function handleStatus(raw) {
  const eventId = await recordStatusEvent({
    waMessageId: raw.waMessageId,
    status: raw.status,
    timestamp: raw.timestamp,
    errorCode: raw.errorCode,
    errorDetail: raw.errorDetail,
    // Safe, credential-free copy of the status object only.
    payload: {
      id: raw.waMessageId,
      status: raw.status,
      timestamp: raw.timestamp,
      recipientId: raw.recipientId,
      errorCode: raw.errorCode,
      errorDetail: raw.errorDetail,
    },
  });

  if (!eventId) return { updated: false, duplicate: true };

  const result = await applyStatusEvent(eventId);
  return { updated: result.applied };
}

/**
 * Serialised through an in-process chain so Meta's redeliveries interleave
 * cleanly with our own writes. Swap this module for a real queue (SQS, BullMQ)
 * if you ever run more than one API instance.
 */
let queue = Promise.resolve();

export function ingestWebhookPayload(payload) {
  const { inbound, statuses, calls, callStatuses } = parseWebhookPayload(payload);

  const work = queue.then(async () => {
    const summary = { inbound: 0, statuses: 0, calls: 0, failed: 0 };

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

    // Module 12 — call connect/terminate events. Guarded so a calling problem
    // can never affect message ingestion; duplicates are absorbed by the
    // call_events dedupe key.
    for (const raw of calls) {
      try {
        if (await handleCallEvent(raw)) summary.calls += 1;
      } catch (error) {
        summary.failed += 1;
        console.error('Failed to process call event', raw.waCallId, error.message);
      }
    }

    for (const raw of callStatuses) {
      try {
        if (await handleCallStatus(raw)) summary.calls += 1;
      } catch (error) {
        summary.failed += 1;
        console.error('Failed to apply call status', raw.waCallId, error.message);
      }
    }

    // A receipt can race the local `sent` write (or arrive for a message another
    // instance just stored). Sweep the still-unmatched events once now; the boot
    // timer in index.js is the safety net for anything that lands later.
    if (statuses.length) {
      try {
        await reconcileStatusEvents({ limit: 50 });
      } catch (error) {
        console.error('Status reconciliation failed:', error.message);
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