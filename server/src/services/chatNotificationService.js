import db from '../config/db.js';
import { isWorkerOnline } from '../socket.js';
import { CHAT_NOTIFICATION_TYPE, notifyWorkerId } from './chatNotificationTypes.js';

/**
 * Chat -> notification_log bridge.
 *
 * The panels already read `/notifications/:workerId` and render whatever is in
 * `notification_log` (SuperAdminPanel.jsx, and the same drawer in the other
 * panels). What was missing was anything writing chat into that table, so a
 * message posted while you had the panel closed left no trace anywhere.
 *
 * Two rules keep it from being noise, both of them product decisions rather
 * than technical ones:
 *
 *   - Someone who already has a live socket is looking at the room, so they get
 *     no row. They get the realtime frame instead.
 *   - The Super Admin gets no rows at all, online or not. They are the only
 *     moderator in a 70-person room, so a desktop notification per message would
 *     be unusable, and notification_log cannot hold a row for them anyway (see
 *     below). They still see everything live, and the unread badge on the
 *     Community nav item covers the case where they had the room closed.
 *
 * `worker_id` is the participant's `subject_id`, which for a worker is their
 * workers uuid. The env-configured Super Admin is the one exception and is
 * deliberately left out: notification_log.worker_id is a uuid with a foreign key
 * into workers(id), and they have no workers row, so no row could ever belong to
 * them. See notifyWorkerId().
 *
 * Best effort by design: a failed notification must never fail the message.
 */

const PREVIEW_LEN = 120;

function preview(msg) {
  if (msg.deleted_at) return 'Message deleted';
  if (msg.attachment_url && !msg.body) return 'Sent an attachment';
  const body = String(msg.body || '').replace(/\s+/g, ' ').trim();
  if (!body) return 'Sent an attachment';
  return body.length > PREVIEW_LEN ? `${body.slice(0, PREVIEW_LEN - 1)}…` : body;
}

/**
 * @param {object} conversation  row from chat_conversations
 * @param {object} message       the message row just inserted
 * @param {object} sender        { uid, subjectId, name, role }
 * @param {Array}  participants  other participants, as chat_participants rows
 */
export async function notifyParticipantsOfMessage(conversation, message, sender, participants) {
  try {
    const isCommunity = conversation.kind === 'group';
    const senderSubject = String(sender.subjectId ?? '');
    const from = sender.name || 'Someone';
    const title = isCommunity ? `Community · ${from}` : from;

    const rows = [];
    for (const p of participants) {
      const subjectId = String(p.subject_id ?? '');
      if (!subjectId || subjectId === senderSubject) continue;
      if (p.uid === sender.uid) continue;

      // Already looking at the app: the socket delivered it live.
      if (isWorkerOnline(subjectId)) continue;

      // notification_log.worker_id is a uuid; a subject_id that is not one would
      // take the whole batch down, so it is dropped here instead.
      const workerId = notifyWorkerId(subjectId);
      if (!workerId) continue;

      rows.push({
        worker_id: workerId,
        type: CHAT_NOTIFICATION_TYPE,
        title,
        body: preview(message),
        // Reuses the existing reference column so a row can be traced back to
        // the conversation without a schema change.
        fro_donor_log_id: String(conversation.id),
        sent_at: new Date().toISOString(),
      });
    }

    if (!rows.length) return { queued: 0, skippedOnline: participants.length - 1 };

    const { error } = await db
      .from('notification_log')
      .insert(rows);
    if (error) {
      console.warn('[chat notify] insert failed:', error.message);
      return { queued: 0, error: error.message };
    }
    return { queued: rows.length };
  } catch (e) {
    // Never let a notification failure surface as a failed send.
    console.warn('[chat notify] skipped:', e?.message || String(e));
    return { queued: 0, error: e?.message };
  }
}
