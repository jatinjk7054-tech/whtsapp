import db from '../config/db.js';
import * as chat from '../models/chatModel.js';
import { emitChat } from '../socket.js';
import { notFound } from '../middleware/chatAccess.js';
import { notifyParticipantsOfMessage } from '../services/chatNotificationService.js';

/**
 * Community Chat HTTP handlers (plan.md §6).
 *
 * Two invariants are enforced in every single handler, deliberately repeated
 * rather than factored into middleware, because the cost of missing one is a
 * private message leaking to the wrong person:
 *
 *   1. the caller must have a chat_participants row for the conversation
 *      (otherwise 404 - never 403, so existence cannot be probed)
 *   2. a `kind='direct'` conversation additionally requires a writer role
 */

const MAX_BODY = 4000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHAT_BUCKET = 'chat-media';
const CHAT_PREFIX = 'chat/';

// Chat's own copy of the upload allow-list. The global list at index.js:274 is
// intentionally not reused: widening that one would silently widen every other
// upload endpoint in the app.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/quicktime',
]);

/** Resolves the caller or ends the request. */
function identify(req, res) {
  const me = chat.resolveChatIdentity(req.user);
  if (!me) {
    res.status(401).json({ message: 'No usable chat identity for this account' });
    return null;
  }
  return me;
}

/**
 * Loads a conversation the caller is allowed to see, or ends the request.
 * `writerOnly` additionally demands a writer role (used for DMs).
 */
async function authorize(req, res, { writerOnly = false } = {}) {
  const me = identify(req, res);
  if (!me) return null;

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    notFound(res);
    return null;
  }
  const convo = await chat.getConversation(id);
  if (!convo) {
    notFound(res);
    return null;
  }
  // A read-only role must never reach a DM even if a participant row existed.
  if (convo.kind === 'direct' && !me.canPost) {
    notFound(res);
    return null;
  }
  if (writerOnly && !me.canPost) {
    res.status(403).json({ message: 'Only Super Admin and Accounts can post in chat.' });
    return null;
  }
  const participant = await chat.getParticipant(convo.id, me.uid);
  if (!participant) {
    notFound(res);
    return null;
  }
  return { me, convo, participant };
}

async function uploadAttachment(file) {
  const key = `${CHAT_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const { error } = await db.storage
    .from(CHAT_BUCKET)
    .upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new Error(error.message);
  const { data } = db.storage.from(CHAT_BUCKET).getPublicUrl(key);
  return {
    url: data?.publicUrl,
    name: file.originalname,
    type: file.mimetype,
    size: file.size,
  };
}

// ---------------------------------------------------------------------------
// GET /conversations
// ---------------------------------------------------------------------------

/**
 * Bare shapes, no wrapper envelopes.
 *
 * `api()` on the client returns the parsed body untouched, and every consumer
 * destructures it directly - ConversationList does `Array.isArray(list)`,
 * useChatRealtime does `Number(n)`. So a `{ conversations: [...] }` wrapper
 * would silently yield an empty rail and a NaN badge rather than an error.
 */
export const listConversations = async (req, res) => {
  try {
    const me = identify(req, res);
    if (!me) return;
    const rows = await chat.listConversationsFor(me);
    res.json(rows.map(chat.toConversationDto));
  } catch (err) {
    console.error('[chat] listConversations', err);
    res.status(500).json({ message: 'Could not load conversations' });
  }
};

// ---------------------------------------------------------------------------
// GET /people  (writer)
// ---------------------------------------------------------------------------

export const listPeople = async (req, res) => {
  try {
    const me = identify(req, res);
    if (!me) return;
    const rows = await chat.listDmTargets(me);
    res.json(
      rows.map((p) => ({
        id: p.uid,
        uid: p.uid,
        subject_id: p.subject_id,
        name: p.name,
        email: p.email,
        role: p.role,
      }))
    );
  } catch (err) {
    console.error('[chat] listPeople', err);
    res.status(500).json({ message: 'Could not load people' });
  }
};

// ---------------------------------------------------------------------------
// POST /conversations/direct  (writer)
// ---------------------------------------------------------------------------

/** Find-or-create by sorted slug, so opening the same DM twice is idempotent. */
export const openDirect = async (req, res) => {
  try {
    const me = identify(req, res);
    if (!me) return;
    if (!me.canPost) {
      return res.status(403).json({ message: 'Only Super Admin and Accounts can start direct messages.' });
    }
    // The client sends `user_id`; accept `uid` too so the two spellings cannot
    // drift into a 400 that is hard to read from the network tab.
    const targetUid = String(req.body?.user_id ?? req.body?.uid ?? '').trim();
    if (!targetUid) return res.status(400).json({ message: 'user_id is required' });
    if (targetUid === me.uid) {
      return res.status(400).json({ message: 'You cannot start a conversation with yourself' });
    }

    const targets = await chat.listDmTargets(me);
    const target = targets.find((t) => t.uid === targetUid);
    if (!target) {
      // Do not confirm whether an arbitrary uid exists as a DM-capable account.
      return res.status(404).json({ message: 'Person not found' });
    }

    const convo = await chat.ensureDirectConversation(me.uid, target.uid, {
      creatorUid: me.uid,
      a: {
        uid: me.uid, subjectId: me.subjectId, role: me.role,
        canPost: true, name: me.name,
      },
      b: {
        uid: target.uid, subjectId: target.subject_id, role: target.role,
        canPost: true, name: target.name, email: target.email, ngoId: target.ngo_id,
      },
    });

    // Returned bare: the caller does `const convo = await createDirect(...)`
    // and then reads convo.id.
    res.json(chat.toConversationDto({
      id: convo.id,
      kind: convo.kind,
      title: target.name,
      peer: { ...target, display_name: target.name },
    }));
  } catch (err) {
    console.error('[chat] openDirect', err);
    res.status(500).json({ message: 'Could not open the conversation' });
  }
};

// ---------------------------------------------------------------------------
// GET /conversations/:id/messages
// ---------------------------------------------------------------------------

export const listMessages = async (req, res) => {
  try {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    const { convo } = ctx;
    const before = req.query.before ? Number(req.query.before) : null;
    const { messages, hasMore } = await chat.listMessages(convo.id, {
      before: Number.isFinite(before) ? before : null,
      limit: req.query.limit,
    });
    res.json({ messages: messages.map(chat.toMessageDto), has_more: hasMore });
  } catch (err) {
    console.error('[chat] listMessages', err);
    res.status(500).json({ message: 'Could not load messages' });
  }
};

// ---------------------------------------------------------------------------
// POST /conversations/:id/messages  (writer)
// ---------------------------------------------------------------------------

export const sendMessage = async (req, res) => {
  try {
    const ctx = await authorize(req, res, { writerOnly: true });
    if (!ctx) return;
    const { me, convo } = ctx;

    const body = String(req.body?.body || '').trim();
    if (body.length > MAX_BODY) {
      return res.status(400).json({ message: `Message is too long (max ${MAX_BODY} characters)` });
    }
    const file = req.file || null;
    if (!body && !file) {
      return res.status(400).json({ message: 'Message cannot be empty' });
    }
    if (file) {
      if (file.size > MAX_FILE_BYTES) {
        return res.status(400).json({ message: 'File is larger than 25 MB' });
      }
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return res.status(400).json({ message: 'That file type cannot be attached' });
      }
    }

    const attachment = file ? await uploadAttachment(file) : null;
    const { message, duplicate } = await chat.insertMessage({
      conversationId: convo.id,
      senderUid: me.uid,
      senderRole: me.role,
      senderName: me.name,
      body,
      attachment,
      clientId: req.body?.client_id || null,
    });
    await chat.touchConversation(convo.id);

    const dto = chat.toMessageDto(message);
    if (!duplicate) {
      // Room-scoped, not emitDbChange - see emitChat's note on DM containment.
      // Broadcasts the DTO, not the row, so a live message carries its
      // attachment exactly like one that arrived on a page load.
      emitChat(convo.id, { type: 'message:new', conversation_id: convo.id, message: dto });

      // Queue desktop/in-app notifications for everyone who was not already
      // looking at the room. Skipped on a duplicate replay so a retried send
      // does not notify everyone twice. Not awaited: the response should not
      // wait on a notification insert, and the service swallows its own errors.
      chat.listParticipants(convo.id)
        .then((participants) =>
          notifyParticipantsOfMessage(convo, message, me, participants)
        )
        .catch((e) => console.warn('[chat] notify fan-out failed:', e?.message || String(e)));
    }
    res.status(duplicate ? 200 : 201).json(dto);
  } catch (err) {
    console.error('[chat] sendMessage', err);
    res.status(500).json({ message: 'Could not send the message' });
  }
};

// ---------------------------------------------------------------------------
// POST /conversations/:id/read
// ---------------------------------------------------------------------------

export const markRead = async (req, res) => {
  try {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    const { me, convo } = ctx;
    const messageId = req.body?.message_id;
    await chat.markRead(convo.id, me.uid, messageId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[chat] markRead', err);
    res.status(500).json({ message: 'Could not update read state' });
  }
};

// ---------------------------------------------------------------------------
// GET /conversations/:id/search
// ---------------------------------------------------------------------------

export const searchMessages = async (req, res) => {
  try {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    const { convo } = ctx;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const rows = await chat.searchMessages(convo.id, q, req.query.limit);
    res.json(rows.map(chat.toMessageDto));
  } catch (err) {
    console.error('[chat] searchMessages', err);
    res.status(500).json({ message: 'Search failed' });
  }
};

// ---------------------------------------------------------------------------
// PATCH /messages/:id  (writer + sender)
// ---------------------------------------------------------------------------

export const editMessage = async (req, res) => {
  try {
    const me = identify(req, res);
    if (!me) return;
    if (!me.canPost) {
      return res.status(403).json({ message: 'Only Super Admin and Accounts can edit messages.' });
    }
    const msg = await chat.getMessage(Number(req.params.id));
    if (!msg) return notFound(res);
    const convo = await chat.getConversation(msg.conversation_id);
    if (!convo) return notFound(res);
    if (!(await chat.isParticipant(convo.id, me.uid))) return notFound(res);

    // Edit is always sender-only, moderator or not.
    if (msg.sender_uid !== me.uid) {
      return res.status(403).json({ message: 'You can only edit your own messages' });
    }
    if (msg.deleted_at) {
      return res.status(400).json({ message: 'A deleted message cannot be edited' });
    }
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ message: 'Message cannot be empty' });
    if (body.length > MAX_BODY) {
      return res.status(400).json({ message: `Message is too long (max ${MAX_BODY} characters)` });
    }

    const updated = chat.toMessageDto(await chat.updateMessageBody(msg.id, body));
    emitChat(convo.id, { type: 'message:update', conversation_id: convo.id, message: updated });
    res.json(updated);
  } catch (err) {
    console.error('[chat] editMessage', err);
    res.status(500).json({ message: 'Could not edit the message' });
  }
};

// ---------------------------------------------------------------------------
// DELETE /messages/:id  (writer + sender, or superadmin in a group room)
// ---------------------------------------------------------------------------

/**
 * Moderation is Community-room only (plan.md §6.2). A superadmin inside a DM is
 * an ordinary participant and gets no authority over the other person's
 * messages.
 */
export const deleteMessage = async (req, res) => {
  try {
    const me = identify(req, res);
    if (!me) return;
    if (!me.canPost) {
      return res.status(403).json({ message: 'Only Super Admin and Accounts can delete messages.' });
    }
    const msg = await chat.getMessage(Number(req.params.id));
    if (!msg) return notFound(res);
    const convo = await chat.getConversation(msg.conversation_id);
    if (!convo) return notFound(res);
    if (!(await chat.isParticipant(convo.id, me.uid))) return notFound(res);

    const isModerator = me.role === 'super_admin' && convo.kind === 'group';
    if (!isModerator && msg.sender_uid !== me.uid) {
      return res.status(403).json({ message: 'You can only delete your own messages' });
    }

    const updated = chat.toMessageDto(await chat.softDeleteMessage(msg.id));
    emitChat(convo.id, { type: 'message:update', conversation_id: convo.id, message: updated });
    res.json(updated);
  } catch (err) {
    console.error('[chat] deleteMessage', err);
    res.status(500).json({ message: 'Could not delete the message' });
  }
};

// ---------------------------------------------------------------------------
// GET /unread-count
// ---------------------------------------------------------------------------

export const unreadCount = async (req, res) => {
  try {
    const me = identify(req, res);
    if (!me) return;
    // A bare number: the badge does `Number(n) || 0`.
    res.json(await chat.unreadCountFor(me.uid));
  } catch (err) {
    console.error('[chat] unreadCount', err);
    res.status(500).json({ message: 'Could not load unread count' });
  }
};
