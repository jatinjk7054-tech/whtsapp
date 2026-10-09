import { query } from '../db/pool.js';

const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.direction, m.status, m.type, m.body,
  m.wa_message_id, m.media_url, m.error_code, m.error_detail,
  m.sent_by_staff_id, m.read_at, m.created_at,
  m.reply_to_id, m.reply_to_wa_message_id, m.is_forwarded,
  m.template_name, m.template_language, m.template_params,
  s.name AS sent_by_staff_name,
  q.body AS quoted_body, q.type AS quoted_type, q.direction AS quoted_direction,
  q.media_url AS quoted_media_url, q.created_at AS quoted_created_at,
  qs.name AS quoted_staff_name
`;

const MESSAGE_FROM = `
  FROM messages m
  LEFT JOIN staff s ON s.id = m.sent_by_staff_id
  LEFT JOIN messages q ON q.id = m.reply_to_id
  LEFT JOIN staff qs ON qs.id = q.sent_by_staff_id
`;

export async function listMessages(conversationId, { limit = 50, before } = {}) {
  const conditions = ['m.conversation_id = $1'];
  const values = [conversationId];

  if (before) {
    values.push(before);
    conditions.push(`m.created_at < (SELECT created_at FROM messages WHERE id = $${values.length})`);
  }

  // Newest-first for pagination, then flipped so the UI renders oldest-first.
  const rows = await query(
    `SELECT ${MESSAGE_COLUMNS}
       ${MESSAGE_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${values.length + 1}`,
    [...values, limit]
  );

  return rows.rows.reverse();
}

export async function findMessageByMediaId(mediaId) {
  const result = await query(`SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE m.media_url = $1`, [
    `/api/media/${mediaId}`,
  ]);
  return result.rows[0] ?? null;
}

export async function insertInboundMessage({
  conversationId,
  waMessageId,
  type,
  body,
  mediaUrl,
  replyToId = null,
  replyToWaMessageId = null,
}) {
  const result = await query(
    `INSERT INTO messages
       (conversation_id, direction, status, type, body, wa_message_id, media_url,
        reply_to_id, reply_to_wa_message_id)
     VALUES ($1, 'inbound', 'received', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [conversationId, type, body, waMessageId, mediaUrl ?? null, replyToId, replyToWaMessageId]
  );

  return result.rows[0] ?? null;
}

export async function insertOutboundMessage({
  conversationId,
  sentByStaffId,
  type,
  body,
  mediaUrl,
  replyToId = null,
  isForwarded = false,
  templateName = null,
  templateLanguage = null,
  templateParams = null,
}) {
  const result = await query(
    `INSERT INTO messages
       (conversation_id, direction, status, type, body, media_url, sent_by_staff_id,
        reply_to_id, is_forwarded, template_name, template_language, template_params)
     VALUES ($1, 'outbound', 'queued', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING id`,
    [
      conversationId,
      type,
      body,
      mediaUrl ?? null,
      sentByStaffId ?? null,
      replyToId,
      isForwarded,
      templateName,
      templateLanguage,
      templateParams == null ? null : JSON.stringify(templateParams),
    ]
  );

  return result.rows[0].id;
}

/** Local row behind a wamid, used to resolve an inbound reply context. */
export async function findMessageIdByWaMessageId(waMessageId) {
  if (!waMessageId) return null;
  const result = await query(`SELECT id FROM messages WHERE wa_message_id = $1`, [waMessageId]);
  return result.rows[0]?.id ?? null;
}

/** Full source row for Reply/Forward validation. */
export async function findMessageById(id) {
  const result = await query(
    `SELECT id, conversation_id, direction, type, body, media_url, wa_message_id, created_at
       FROM messages WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Server-side message search. Matches partial text, customer name and WhatsApp
 * number (digits normalised so "+91 98765 43210" still finds the stored wa_id).
 * `scope` mirrors the inbox: { assignedStaffId: n|null } for an agent, {} for an
 * admin. Always LIMITed — the browser never receives the full message history.
 */
export async function searchMessages({ scopeAssignedStaffId, search, limit = 50 }) {
  const values = [];
  const conditions = [];

  values.push(`%${search}%`);
  const textOrName = `(m.body ILIKE $1 OR ct.name ILIKE $1)`;

  const digits = search.replace(/\D/g, '');
  if (digits && digits !== search) {
    values.push(`%${digits}%`);
    conditions.push(`(${textOrName} OR ct.wa_id ILIKE $2)`);
  } else {
    // Parentheses are load-bearing: the scope condition below must AND with the
    // whole match group, not just its last OR branch.
    conditions.push(`(${textOrName} OR ct.wa_id ILIKE $1)`);
  }

  if (scopeAssignedStaffId !== undefined) {
    if (scopeAssignedStaffId === null) {
      conditions.push('c.assigned_staff_id IS NULL');
    } else {
      values.push(scopeAssignedStaffId);
      conditions.push(`c.assigned_staff_id = $${values.length}`);
    }
  }

  values.push(Math.min(Math.max(Number(limit) || 50, 1), 50));

  const result = await query(
    `SELECT m.id, m.conversation_id, m.direction, m.type, m.status, m.body,
            m.media_url, m.created_at,
            ct.name AS contact_name, ct.wa_id AS contact_wa_id,
            c.status AS conversation_status, c.assigned_staff_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

export async function attachOutboundMedia(id, mediaUrl) {
  await query(`UPDATE messages SET media_url = $2 WHERE id = $1`, [id, mediaUrl ?? null]);
}

export async function confirmOutboundMessage(id, waMessageId) {
  const result = await query(
    `UPDATE messages SET wa_message_id = $2, status = 'sent'
     WHERE id = $1 RETURNING id, wa_message_id, status`,
    [id, waMessageId]
  );
  return result.rows[0] ?? null;
}

export async function failOutboundMessage(id, errorCode, errorDetail) {
  await query(
    `UPDATE messages SET status = 'failed', error_code = $2, error_detail = $3 WHERE id = $1`,
    [id, errorCode ?? null, errorDetail ?? null]
  );
}

export async function applyProviderStatus(waMessageId, status, errorCode, errorDetail) {
  const result = await query(
    `UPDATE messages
        SET status = CASE WHEN $2 = 'failed' THEN 'failed' ELSE $2 END,
            error_code = COALESCE($3, error_code),
            error_detail = COALESCE($4, error_detail)
      WHERE wa_message_id = $1
      RETURNING id, conversation_id, status`,
    [waMessageId, status, errorCode ?? null, errorDetail ?? null]
  );

  return result.rows[0] ?? null;
}

export async function markConversationRead(conversationId, staffId) {
  const result = await query(
    `UPDATE messages
        SET read_at = NOW()
      WHERE conversation_id = $1
        AND direction = 'inbound'
        AND read_at IS NULL
      RETURNING id`,
    [conversationId]
  );

  return { marked: result.rowCount, ids: result.rows.map((row) => row.id) };
}

export async function recordWebhookEvent(waMessageId, payload) {
  const result = await query(
    `INSERT INTO webhook_events (wa_message_id, payload) VALUES ($1, $2)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [waMessageId, payload]
  );

  return result.rowCount > 0;
}