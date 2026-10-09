import db from '../config/db.js';

export async function getOverview({ project, days = 30 }) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const { rows } = await db._pool.query(
    `
    WITH conv AS (
      SELECT c.id, c.status, c.project,
        (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS first_in,
        (SELECT MIN(m.created_at) FROM messages m
           WHERE m.conversation_id = c.id AND m.direction = 'outbound'
             AND m.created_at > (SELECT MIN(m2.created_at) FROM messages m2
                                 WHERE m2.conversation_id = c.id AND m2.direction = 'inbound')) AS first_out
      FROM conversations c
      WHERE c.created_at > now() - ($2 || ' days')::interval
        AND ($1::text IS NULL OR c.project = $1)
    )
    SELECT
      (SELECT count(*) FROM conv) AS total_conversations,
      (SELECT count(*) FROM conv WHERE status = 'closed') AS closed_conversations,
      (SELECT count(*) FROM conv WHERE first_out IS NOT NULL) AS responded_conversations,
      (SELECT AVG(EXTRACT(EPOCH FROM (first_out - first_in)) / 60.0) FROM conv WHERE first_out IS NOT NULL) AS avg_first_response_mins,
      (SELECT count(*) FROM messages WHERE direction = 'inbound' AND created_at > now() - ($2 || ' days')::interval AND ($1::text IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE project = $1))) AS inbound_messages,
      (SELECT count(*) FROM messages WHERE direction = 'outbound' AND created_at > now() - ($2 || ' days')::interval AND ($1::text IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE project = $1))) AS outbound_messages,
      (SELECT count(*) FROM messages WHERE status = 'failed' AND created_at > now() - ($2 || ' days')::interval AND ($1::text IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE project = $1))) AS failed_messages,
      (SELECT count(*) FROM messages WHERE message_category = 'ai_reply' AND created_at > now() - ($2 || ' days')::interval AND ($1::text IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE project = $1))) AS ai_replies,
      (SELECT count(*) FROM contacts WHERE source = 'whatsapp' AND created_at > now() - ($2 || ' days')::interval) AS new_whatsapp_contacts
    `,
    [project || null, String(d)]
  );
  return rows[0] || {};
}

export async function getDailyVolumes({ project, days = 14 }) {
  const d = Math.max(1, Math.min(120, parseInt(days, 10) || 14));
  const { rows } = await db._pool.query(
    `
    WITH span AS (
      SELECT generate_series(
        (now() - ($2 || ' days')::interval)::date,
        now()::date,
        '1 day'
      )::date AS day
    )
    SELECT s.day::text AS day,
      count(m.id) FILTER (WHERE m.direction = 'inbound') AS inbound,
      count(m.id) FILTER (WHERE m.direction = 'outbound') AS outbound
    FROM span s
    LEFT JOIN messages m
      ON m.created_at::date = s.day
      AND ($1::text IS NULL OR m.conversation_id IN (SELECT id FROM conversations WHERE project = $1))
    GROUP BY s.day
    ORDER BY s.day
    `,
    [project || null, String(d)]
  );
  return rows;
}

export async function getAgentPerformance({ project, days = 30 }) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const { rows } = await db._pool.query(
    `
    SELECT m.user_id AS agent,
      count(*) AS replies,
      count(*) FILTER (WHERE m.status = 'failed') AS failed
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.direction = 'outbound'
      AND m.user_id IS NOT NULL AND m.user_id <> 'ai-bot'
      AND m.created_at > now() - ($2 || ' days')::interval
      AND ($1::text IS NULL OR c.project = $1)
    GROUP BY m.user_id
    ORDER BY replies DESC
    LIMIT 20
    `,
    [project || null, String(d)]
  );
  return rows;
}

export async function getBroadcastAnalytics() {
  const { rows } = await db._pool.query(
    `
    SELECT b.id, b.name, b.account_project, b.template_name, b.status,
           b.total_count, b.sent_count, b.failed_count, b.created_at, b.completed_at,
           (SELECT count(*) FROM whatsapp_broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status IN ('delivered', 'read')) AS delivered_count,
           (SELECT count(*) FROM whatsapp_broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'read') AS read_count,
           (SELECT count(DISTINCT r.id) FROM whatsapp_broadcast_recipients r
              JOIN contacts ct ON ct.id = r.contact_id
              JOIN conversations cv ON cv.contact_id = ct.id
              JOIN messages m ON m.conversation_id = cv.id AND m.direction = 'inbound' AND m.created_at > r.sent_at
            WHERE r.broadcast_id = b.id AND r.sent_at IS NOT NULL) AS replied_count
    FROM whatsapp_broadcasts b
    ORDER BY b.created_at DESC
    LIMIT 50
    `
  );
  return rows.map((r) => ({
    ...r,
    delivery_rate: r.sent_count > 0 ? +(r.delivered_count / r.sent_count).toFixed(4) : 0,
    read_rate: r.sent_count > 0 ? +(r.read_count / r.sent_count).toFixed(4) : 0,
    reply_rate: r.delivered_count > 0 ? +(r.replied_count / r.delivered_count).toFixed(4) : 0,
  }));
}
