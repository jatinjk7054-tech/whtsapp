import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const messageStatusSchemaPath = path.join(here, '..', 'db', 'message_status.schema.sql');

/** Applies message_status.schema.sql. Idempotent — safe on every boot. */
export async function ensureMessageStatusSchema() {
  const sql = await readFile(messageStatusSchemaPath, 'utf8');
  await query(sql);
}

const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.direction, m.status, m.type, m.body,
  m.wa_message_id, m.media_url, m.error_code, m.error_detail,
  m.sent_by_staff_id, m.read_at, m.created_at,
  m.status_updated_at, m.delivered_at, m.read_receipt_at,
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
     VALUES ($1, 'outbound', 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
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
    `UPDATE messages SET wa_message_id = $2, status = 'sent', status_updated_at = NOW()
     WHERE id = $1 RETURNING id, wa_message_id, status`,
    [id, waMessageId]
  );
  return result.rows[0] ?? null;
}

export async function failOutboundMessage(id, errorCode, errorDetail) {
  await query(
    `UPDATE messages
        SET status = 'failed', error_code = $2, error_detail = $3, status_updated_at = NOW()
      WHERE id = $1`,
    [id, errorCode ?? null, errorDetail ?? null]
  );
}

// Receipt states in delivery order. 'failed' is terminal and deliberately has no
// rank — the WHERE clause below treats it separately.
const STATUS_RANK_SQL = (expr) =>
  `(CASE ${expr} WHEN 'pending' THEN 0 WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 ` +
  `WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE -1 END)`;

/**
 * Applies a delivery/read receipt from Meta. Only ever moves an outbound row
 * forward (pending -> sent -> delivered -> read) and never lets a redelivered or
 * out-of-order event downgrade it — an ancient 'sent' can no longer erase a
 * 'read'. 'failed' is terminal: it is applied up until the message is read, and
 * once set it is never overwritten. Returns the updated row, or null when the
 * wamid is unknown or the transition was a no-op.
 */
export async function applyProviderStatus(
  waMessageId,
  status,
  { errorCode = null, errorDetail = null, timestamp = null } = {}
) {
  const result = await query(
    `UPDATE messages
        SET status = CASE WHEN $2 = 'failed' THEN 'failed' ELSE $2 END,
            error_code = CASE WHEN $2 = 'failed' THEN COALESCE($3, error_code) ELSE error_code END,
            error_detail = CASE WHEN $2 = 'failed' THEN COALESCE($4, error_detail) ELSE error_detail END,
            delivered_at = CASE
              WHEN $2 = 'delivered' THEN COALESCE(delivered_at, $5::timestamptz, NOW())
              ELSE delivered_at END,
            read_receipt_at = CASE
              WHEN $2 = 'read' THEN COALESCE(read_receipt_at, $5::timestamptz, NOW())
              ELSE read_receipt_at END,
            status_updated_at = NOW()
      WHERE wa_message_id = $1
        AND direction = 'outbound'
        AND status <> 'failed'
        AND (
          ($2 = 'failed' AND status <> 'read')
          OR (
            $2 <> 'failed'
            AND ${STATUS_RANK_SQL('$2')} >= ${STATUS_RANK_SQL('status')}
          )
        )
      RETURNING id, conversation_id, status`,
    [waMessageId, status, errorCode, errorDetail, timestamp]
  );

  return result.rows[0] ?? null;
}

/**
 * Records one raw status webhook. `dedupe_key` makes Meta's redeliveries (and a
 * follow-up 'delivered' after 'sent' on the same wamid) safe: the first insert
 * wins, later identical events are ignored. Returns the new row id, or null when
 * the event was a duplicate.
 */
export async function recordStatusEvent({
  waMessageId,
  status,
  timestamp = null,
  errorCode = null,
  errorDetail = null,
  payload = null,
}) {
  const dedupeKey = `${waMessageId}:${status}:${timestamp ?? ''}`;
  const result = await query(
    `INSERT INTO message_status_events
       (dedupe_key, wa_message_id, status, event_timestamp, error_code, error_detail, payload)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      dedupeKey,
      waMessageId,
      status,
      timestamp,
      errorCode,
      errorDetail,
      payload == null ? null : JSON.stringify(payload),
    ]
  );

  return result.rows[0]?.id ?? null;
}

/** Applies one stored status event, marking it resolved when the message exists. */
export async function applyStatusEvent(eventId) {
  const event = await query(
    `SELECT id, wa_message_id, status, event_timestamp, error_code, error_detail
       FROM message_status_events WHERE id = $1`,
    [eventId]
  );
  const row = event.rows[0];
  if (!row) return { applied: false };

  const updated = await applyProviderStatus(row.wa_message_id, row.status, {
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    timestamp: row.event_timestamp,
  });

  if (updated) {
    await query(
      `UPDATE message_status_events
          SET matched_message_id = $2, applied_at = NOW()
        WHERE id = $1 AND applied_at IS NULL`,
      [eventId, updated.id]
    );
    return { applied: true, message: updated };
  }

  return { applied: false };
}

/**
 * Retries status events that could not be matched when they arrived (Meta's
 * receipt can race our own `sent` write). Bounded to the last day so a genuinely
 * unknown wamid is not retried forever.
 */
export async function reconcileStatusEvents({ limit = 100 } = {}) {
  const result = await query(
    `SELECT id FROM message_status_events
      WHERE applied_at IS NULL
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY id
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );

  let applied = 0;
  for (const row of result.rows) {
    if ((await applyStatusEvent(row.id)).applied) applied += 1;
  }

  return { scanned: result.rows.length, applied };
}

/** Source row for the Retry action. */
export async function findRetryableMessage(id) {
  const result = await query(
    `SELECT id, conversation_id, direction, status, type, body, media_url,
            reply_to_id, is_forwarded, template_name, template_language,
            template_params, wa_message_id, sent_by_staff_id, created_at
       FROM messages WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** Puts a failed row back to 'pending' so a retry can reuse the same bubble. */
export async function resetOutboundForRetry(id) {
  await query(
    `UPDATE messages
        SET status = 'pending', error_code = NULL, error_detail = NULL,
            status_updated_at = NOW()
      WHERE id = $1`,
    [id]
  );
}

export async function markConversationRead(conversationId, staffId) {
  const result = await query(
    `UPDATE messages
        SET read_at = NOW()
      WHERE conversation_id = $1
        AND direction = 'inbound'
        AND read_at IS NULL
      RETURNING id, wa_message_id`,
    [conversationId]
  );

  return {
    marked: result.rowCount,
    ids: result.rows.map((row) => row.id),
    // Wamids of the rows we just marked, so the caller can send WhatsApp's
    // read receipt for exactly the messages the agent actually opened.
    waMessageIds: result.rows.map((row) => row.wa_message_id).filter(Boolean),
  };
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