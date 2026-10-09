import db from '../config/db.js';
import { isWriterRole, CHAT_ROLES } from '../middleware/chatAccess.js';

/**
 * Community Chat data access (plan.md §3).
 *
 * Almost all of this is raw SQL through db._pool rather than the query builder.
 * Chat needs cursor pagination, ILIKE, per-conversation aggregate unread counts
 * and ON CONFLICT idempotency - none of which the builder expresses, and all of
 * which are clearer written out.
 */

const PAGE_MAX = 50;
const PAGE_DEFAULT = 50;

// Role spellings that may post. The `users` table is not perfectly normalized,
// so match case-insensitively and include the common aliases rather than relying
// on normalizeRole to have run at write time.
//
// Must stay in step with CHAT_ROLES in middleware/chatAccess.js, which is what
// actually authorizes a post. 'master' is deliberately NOT here: chatWriter
// rejects it, so listing it would hand someone can_post = true and then 403
// their own messages. If 'master' should moderate chat, add it to CHAT_ROLES
// first, not here.
const CHAT_ROLE_LIST = [
  'super_admin', 'superadmin', 'super admin', 'super-admin', 'sa',
  'accounts', 'accountant',
];

// ---------------------------------------------------------------------------
// Identity (plan.md §4)
// ---------------------------------------------------------------------------

/**
 * `req.user.id` is not a usable chat key: the env-configured Super Admin logs in
 * with id 0, and two such logins would collide on the same identity. So the chat
 * key is derived from the credential that is actually unique.
 */
export function chatUidFor(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const id = user?.id ?? user?.workerId;
  if (id != null && String(id) !== '') return `login:${id}`;
  return null;
}

/**
 * Resolves the caller's chat identity, or null if they have no usable key.
 *
 * `subject_id` is String(req.user.id) because that is what
 * notification_log.worker_id stores and what SuperAdminPanel filters on when
 * deciding whether to show a desktop notification.
 */
export function resolveChatIdentity(user) {
  const uid = chatUidFor(user);
  if (!uid) return null;
  return {
    uid,
    subjectId: String(user.id ?? user.workerId ?? ''),
    role: user.role,
    name: user.name || user.email || 'Unknown',
    canPost: isWriterRole(user.role),
  };
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * Row -> message DTO.
 *
 * The database stores an attachment as four flat columns; the UI wants one
 * nested `attachment` object. This is the only place that translation happens,
 * and it is applied to HTTP responses *and* to the realtime payload - otherwise
 * a message would show its attachment on reload but arrive bare over the socket.
 */
export function toMessageDto(row) {
  if (!row) return null;
  const hasAttachment = !!row.attachment_url;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_uid: row.sender_uid,
    sender_role: row.sender_role,
    sender_name: row.sender_name,
    body: row.deleted_at ? null : row.body,
    attachment: hasAttachment
      ? {
          url: row.attachment_url,
          name: row.attachment_name,
          mime: row.attachment_type,
          size: row.attachment_size == null ? null : Number(row.attachment_size),
        }
      : null,
    client_id: row.client_id,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
  };
}

/** Row -> conversation DTO, matching what the conversation rail renders. */
export function toConversationDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    member_count: row.member_count ?? null,
    peer: row.peer
      ? {
          uid: row.peer.uid,
          subject_id: row.peer.subject_id,
          name: row.peer.display_name,
          email: row.peer.email,
          role: row.peer.role,
        }
      : null,
    unread_count: row.unread || 0,
    last_message: row.last_message_id
      ? {
          id: row.last_message_id,
          sender_uid: row.last_message_sender,
          body: row.last_message_deleted_at
            ? 'This message was deleted'
            : row.last_message_body,
          attachment: row.last_message_attachment
            ? { url: row.last_message_attachment }
            : null,
          created_at: row.last_message_at,
          deleted: !!row.last_message_deleted_at,
        }
      : null,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const COMMUNITY_SLUG = 'community';

export async function getCommunityConversation() {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_conversations WHERE slug = $1 LIMIT 1`,
    [COMMUNITY_SLUG]
  );
  return rows[0] || null;
}

export async function getConversation(id) {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_conversations WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function getConversationBySlug(slug) {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_conversations WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

/** Sorted so `dm:a|b` and `dm:b|a` resolve to the same conversation. */
export const directSlug = (a, b) => `dm:${[a, b].sort().join('|')}`;

export async function ensureDirectConversation(uidA, uidB, meta) {
  const slug = directSlug(uidA, uidB);
  const existing = await getConversationBySlug(slug);
  if (existing) return existing;
  const { rows } = await db._pool.query(
    `INSERT INTO chat_conversations (kind, slug, title, created_by)
     VALUES ('direct', $1, NULL, $2)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [slug, meta.creatorUid]
  );
  const convo = rows[0];
  for (const p of [meta.a, meta.b]) {
    await addParticipant(convo.id, p);
  }
  return convo;
}

export async function touchConversation(id) {
  await db._pool.query(
    `UPDATE chat_conversations SET updated_at = now() WHERE id = $1`,
    [id]
  );
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export async function addParticipant(conversationId, p) {
  const { rows } = await db._pool.query(
    `INSERT INTO chat_participants
       (conversation_id, uid, subject_id, role, can_post, display_name, email, ngo_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (conversation_id, uid) DO UPDATE
       SET subject_id  = EXCLUDED.subject_id,
           role        = EXCLUDED.role,
           can_post    = EXCLUDED.can_post,
           display_name= EXCLUDED.display_name,
           email       = EXCLUDED.email,
           ngo_id      = EXCLUDED.ngo_id
     RETURNING *`,
    [conversationId, p.uid, p.subjectId, p.role, !!p.canPost, p.name, p.email || null, p.ngoId || null]
  );
  return rows[0];
}

export async function getParticipant(conversationId, uid) {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_participants WHERE conversation_id = $1 AND uid = $2`,
    [conversationId, uid]
  );
  return rows[0] || null;
}

export async function isParticipant(conversationId, uid) {
  return !!(await getParticipant(conversationId, uid));
}

export async function listParticipants(conversationId) {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_participants WHERE conversation_id = $1 ORDER BY display_name`,
    [conversationId]
  );
  return rows;
}

/**
 * Conversation list for the rail.
 *
 * Three containment rules live here and are enforced again at the message and
 * search layers, because a single missed filter would leak a DM (plan.md §2.3):
 *   1. only conversations the caller participates in
 *   2. `kind='direct'` rows are dropped entirely for a non-writer
 *   3. the title of a DM is only ever the *other* participant's name
 */
export async function listConversationsFor(me) {
  const { rows } = await db._pool.query(
    `SELECT
        c.id, c.kind, c.title, c.updated_at,
        p.last_read_at, p.last_read_msg_id,
        lm.id         AS last_message_id,
        lm.sender_uid AS last_message_sender,
        lm.created_at AS last_message_at,
        lm.body       AS last_message_body,
        lm.deleted_at AS last_message_deleted_at,
        lm.attachment_url AS last_message_attachment,
        (
          SELECT count(*)
          FROM chat_messages m
          WHERE m.conversation_id = c.id
            AND m.id > COALESCE(p.last_read_msg_id, 0)
            AND m.sender_uid <> $1
            AND m.deleted_at IS NULL
        )::int AS unread,
        (SELECT count(*) FROM chat_participants cp
         WHERE cp.conversation_id = c.id)::int AS member_count
     FROM chat_conversations c
     JOIN chat_participants p
       ON p.conversation_id = c.id AND p.uid = $1
     LEFT JOIN LATERAL (
       SELECT id, sender_uid, created_at, body, deleted_at, attachment_url
       FROM chat_messages
       WHERE conversation_id = c.id
       ORDER BY id DESC
       LIMIT 1
     ) lm ON true
     WHERE c.is_archived = false
       AND (c.kind = 'group' OR $2::boolean)
     ORDER BY COALESCE(lm.created_at, c.updated_at) DESC`,
    [me.uid, me.canPost]
  );

  // Resolve DM titles server-side. A writer sees each peer's name; a read-only
  // role never receives a DM row at all, so this only runs for writer pairs.
  const out = [];
  for (const row of rows) {
    if (row.kind === 'direct') {
      const peer = await getDirectPeer(row.id, me.uid);
      out.push({ ...row, title: peer?.display_name || 'Direct message', peer });
    } else {
      out.push({ ...row, title: row.title || 'Community' });
    }
  }
  return out;
}

async function getDirectPeer(conversationId, uid) {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_participants
     WHERE conversation_id = $1 AND uid <> $2
     LIMIT 1`,
    [conversationId, uid]
  );
  return rows[0] || null;
}

/**
 * DM targets for the "new message" picker. Writers only.
 *
 * Reads `workers` rather than `chat_participants` on purpose: the answer to "who
 * can I message" is a property of the staff roster, not of who happens to
 * already share a room with me. Deriving it from participation would silently
 * shrink the list if Community seeding ever missed a row.
 *
 * Only writer roles can be a DM target, because only writers can open one.
 * The department -> role CASE and the writer filter mirror
 * listCommunityCandidates() and CHAT_ROLE_LIST.
 */
const WORKER_ROLE_CASE = `
  CASE
    WHEN btrim(lower(department)) = 'hr'                THEN 'hr'
    WHEN btrim(lower(department)) LIKE '%recruit%'      THEN 'recruiter'
    WHEN btrim(lower(department)) = 'admin'             THEN 'accounts'
    WHEN btrim(lower(department)) = 'fro'               THEN 'fro'
    WHEN btrim(lower(department)) = 'ngo admin'         THEN 'admin'
    WHEN btrim(lower(department)) = 'digital'
      OR btrim(lower(department)) LIKE '%develop%'      THEN 'digital'
    WHEN btrim(lower(department)) LIKE '%event%'        THEN 'event_head'
    ELSE 'worker'
  END`;

export async function listDmTargets(me) {
  // worker.id is a uuid, so the self-exclusion is a text compare. $2::bigint
  // would make every /people request fail with a cast error.
  const { rows } = await db._pool.query(
    `SELECT id, name, email, login_id, ngo_id, ${WORKER_ROLE_CASE} AS role
     FROM workers
     WHERE COALESCE(is_active, true) = true
       AND employment_status IS DISTINCT FROM 'terminated'
       AND ${WORKER_ROLE_CASE} = ANY($1::text[])
       AND id::text <> $2
     ORDER BY name`,
    [[...CHAT_ROLE_LIST], String(me.subjectId ?? '')]
  );
  return rows.map((u) => ({
    // Workers have no email in their JWT, so the uid must be the login key.
    uid: `login:${u.id}`,
    subject_id: String(u.id),
    name: u.name,
    email: u.email,
    role: u.role,
    ngo_id: u.ngo_id,
  }));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Newest-first cursor page. Returns rows in ascending id order for rendering, so
 * the caller does not have to reverse them.
 */
export async function listMessages(conversationId, { before, limit } = {}) {
  const cap = Math.min(Number(limit) || PAGE_DEFAULT, PAGE_MAX);
  const { rows } = await db._pool.query(
    `SELECT * FROM (
       SELECT * FROM chat_messages
       WHERE conversation_id = $1
         AND ($2::bigint IS NULL OR id < $2::bigint)
       ORDER BY id DESC
       LIMIT $3
     ) page
     ORDER BY id ASC`,
    [conversationId, before || null, cap + 1]
  );
  const hasMore = rows.length > cap;
  return { messages: hasMore ? rows.slice(0, cap) : rows, hasMore };
}

export async function getMessage(id) {
  const { rows } = await db._pool.query(
    `SELECT * FROM chat_messages WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function getNewestMessageId(conversationId) {
  const { rows } = await db._pool.query(
    `SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE conversation_id = $1`,
    [conversationId]
  );
  return Number(rows[0]?.id || 0);
}

/**
 * Insert a message, idempotent on client_id.
 *
 * The client reuses the same client_id when the user hits "Retry" on a failed
 * bubble, and a send can succeed server-side while the response is lost. Both
 * cases arrive here as a duplicate, so the unique index turns them into a
 * successful no-op returning the original row instead of a 500.
 */
export async function insertMessage(msg) {
  const { rows } = await db._pool.query(
    `INSERT INTO chat_messages
       (conversation_id, sender_uid, sender_role, sender_name, body,
        attachment_url, attachment_name, attachment_type, attachment_size,
        client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (conversation_id, client_id) WHERE client_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      msg.conversationId, msg.senderUid, msg.senderRole, msg.senderName,
      msg.body || null, msg.attachment?.url || null, msg.attachment?.name || null,
      msg.attachment?.type || null, msg.attachment?.size || null, msg.clientId || null,
    ]
  );
  if (rows[0]) return { message: rows[0], duplicate: false };

  const { rows: existing } = await db._pool.query(
    `SELECT * FROM chat_messages WHERE conversation_id = $1 AND client_id = $2`,
    [msg.conversationId, msg.clientId]
  );
  if (!existing[0]) throw new Error('Message insert failed');
  return { message: existing[0], duplicate: true };
}

/** Edit is always sender-only (plan.md §6.2). */
export async function updateMessageBody(id, body) {
  const { rows } = await db._pool.query(
    `UPDATE chat_messages
     SET body = $2, edited_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id, body]
  );
  return rows[0] || null;
}

/** Soft delete: the row survives so the client's position anchor stays valid. */
export async function softDeleteMessage(id) {
  const { rows } = await db._pool.query(
    `UPDATE chat_messages
     SET deleted_at = now(), body = NULL, attachment_url = NULL,
         attachment_name = NULL, attachment_type = NULL, attachment_size = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Scoped to a single conversation the caller has already been authorized for, so
 * it cannot reach a DM the caller is not party to.
 */
export async function searchMessages(conversationId, q, limit = 50) {
  const cap = Math.min(Number(limit) || 50, 100);
  const { rows } = await db._pool.query(
    `SELECT id, conversation_id, sender_uid, sender_name, sender_role, body,
            attachment_url, attachment_name, attachment_type, attachment_size,
            edited_at, deleted_at, created_at, client_id
     FROM chat_messages
     WHERE conversation_id = $1
       AND deleted_at IS NULL
       AND body ILIKE '%' || $2 || '%'
     ORDER BY id DESC
     LIMIT $3`,
    [conversationId, q, cap]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/**
 * Upserts the caller's OWN participant row only. This is the one write a
 * read-only role performs, and it cannot touch message content (plan.md §2.4).
 *
 * last_read_msg_id is clamped to the newest message that actually exists, so a
 * stale client cannot mark unseen messages read by sending a large id.
 */
export async function markRead(conversationId, uid, messageId) {
  const newest = await getNewestMessageId(conversationId);
  const target = Math.min(Number(messageId) || 0, newest);
  const { rows } = await db._pool.query(
    `UPDATE chat_participants
     SET last_read_msg_id = GREATEST(COALESCE(last_read_msg_id, 0), $3),
         last_read_at    = now()
     WHERE conversation_id = $1 AND uid = $2
     RETURNING last_read_msg_id`,
    [conversationId, uid, target]
  );
  return rows[0] || null;
}

/**
 * Total unread for the nav badge, across every conversation the caller
 * participates in. DMs are included: a writer with an unread direct message
 * wants the badge on the sidebar tab, not just in the open thread.
 */
export async function unreadCountFor(uid) {
  const { rows } = await db._pool.query(
    `SELECT COALESCE(SUM(u.unread), 0)::int AS total FROM (
       SELECT (
         SELECT count(*) FROM chat_messages m
         WHERE m.conversation_id = c.id
           AND m.id > COALESCE(p.last_read_msg_id, 0)
           AND m.sender_uid <> $1
           AND m.deleted_at IS NULL
       ) AS unread
       FROM chat_conversations c
       JOIN chat_participants p
         ON p.conversation_id = c.id AND p.uid = $1
       WHERE c.is_archived = false
     ) u`,
    [uid]
  );
  return rows[0]?.total || 0;
}

// ---------------------------------------------------------------------------
// Backfill support (ensureChatSchema)
// ---------------------------------------------------------------------------

/**
 * Every identity eligible for the Community room, from `workers`.
 *
 * `workers`, not `users`: the eight panels all authenticate against `workers`
 * (authController.js getWorkerByLoginId), keyed by login_id, and their JWT
 * carries no email. `users` is the CRM side - `agent` and `admin` rows that
 * have no Community page anywhere in the UI.
 *
 * The department -> role CASE is a copy of authController.js, and the
 * department filter below keeps the eight panel departments only, so
 * Housekeeping/operator staff stay out.
 */
export async function listCommunityCandidates() {
  const { rows } = await db._pool.query(
    `SELECT w.id,
            w.name,
            w.email,
            w.login_id,
            w.ngo_id,
            CASE
              WHEN btrim(lower(w.department)) = 'hr'                THEN 'hr'
              WHEN btrim(lower(w.department)) LIKE '%recruit%'      THEN 'recruiter'
              WHEN btrim(lower(w.department)) = 'admin'             THEN 'accounts'
              WHEN btrim(lower(w.department)) = 'fro'               THEN 'fro'
              WHEN btrim(lower(w.department)) = 'ngo admin'         THEN 'admin'
              WHEN btrim(lower(w.department)) = 'digital'
                OR btrim(lower(w.department)) LIKE '%develop%'      THEN 'digital'
              WHEN btrim(lower(w.department)) LIKE '%event%'        THEN 'event_head'
              ELSE 'worker'
            END AS role
     FROM workers w
     WHERE COALESCE(w.is_active, true) = true
       AND w.employment_status IS DISTINCT FROM 'terminated'
       AND (
            btrim(lower(w.department)) IN
              ('hr', 'admin', 'fro', 'ngo admin', 'digital', 'accounts', 'account')
         OR btrim(lower(w.department)) LIKE '%recruit%'
         OR btrim(lower(w.department)) LIKE '%develop%'
         OR btrim(lower(w.department)) LIKE '%event%'
       )
     ORDER BY w.id`
  );
  return rows;
}

/**
 * Removes Community membership for anyone the sync no longer seats.
 *
 * Without this, a deactivated employee or a CRM account keeps a participant
 * row and therefore keeps passing isParticipant() - the reader check would let
 * someone who is no longer staff read the room.
 */
export async function removeStaleParticipants(conversationId, keepUids) {
  const { rows } = await db._pool.query(
    `DELETE FROM chat_participants
     WHERE conversation_id = $1
       AND NOT (uid = ANY($2::text[]))
     RETURNING uid`,
    [conversationId, keepUids]
  );
  return rows.map((r) => r.uid);
}
