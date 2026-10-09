import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const analyticsSchemaPath = path.join(here, '..', 'db', 'analytics.schema.sql');

/**
 * Module 8 — the analytics indexes are `CREATE ... IF NOT EXISTS`, so this is
 * safe to call on every boot and upgrades an existing database with no manual
 * migration step (same pattern as Module 7's status schema).
 */
export async function ensureAnalyticsSchema() {
  const sql = await readFile(analyticsSchemaPath, 'utf8');
  await query(sql);
}

export async function listActiveAgents() {
  const result = await query(
    `SELECT id, name, email, role
       FROM staff
      WHERE role = 'agent' AND is_active = TRUE
      ORDER BY name ASC`
  );
  return result.rows;
}

/**
 * The application timezone. Away-message settings hold the one timezone the
 * product already knows about (seeded Asia/Kolkata); analytics boundaries are
 * derived in that zone so "Today" means the same calendar day on every layer.
 */
export async function getAnalyticsTimezone() {
  const result = await query(`SELECT timezone FROM away_message_settings WHERE id = 1`);
  return result.rows[0]?.timezone || 'Asia/Kolkata';
}

/** Successfully-sent outbound states. Failed / queued rows are never counted. */
const SENT_OUTBOUND = `m.direction = 'outbound'
  AND m.sent_by_staff_id IS NOT NULL
  AND m.status NOT IN ('failed', 'queued', 'pending')`;

/**
 * Conversations actually handled by each agent during the period.
 *
 * "Handled during the period" is defined from the data we have:
 *   - the conversation is currently assigned to the agent (there is no
 *     assignment-history table in this CRM, so current assignment is the only
 *     assignment that exists — see the Module 8 report, §assignment method), and
 *   - at least one message (either direction) was written in [from, to).
 *
 * A conversation is therefore never double counted — each row has exactly one
 * assigned_staff_id and is DISTINCT per conversation.
 */
export async function agentHandledSummary(from, to, timezone) {
  const result = await query(
    `WITH bounds(lo, hi) AS (
       SELECT (($1::date)::timestamp AT TIME ZONE $3),
              ((($2::date) + 1)::timestamp AT TIME ZONE $3)
     ),
     handled AS (
       SELECT DISTINCT c.id AS conversation_id,
                       c.assigned_staff_id,
                       c.contact_id,
                       c.status
         FROM conversations c
        WHERE c.assigned_staff_id IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.conversation_id = c.id
                   AND m.created_at >= (SELECT lo FROM bounds)
                   AND m.created_at <  (SELECT hi FROM bounds)
              )
     )
     SELECT h.assigned_staff_id AS agent_id,
            COUNT(*)::int                                        AS chats_handled,
            COUNT(DISTINCT h.contact_id)::int                    AS customers,
            COUNT(*) FILTER (WHERE h.status = 'open')::int       AS open_count,
            COUNT(*) FILTER (WHERE h.status = 'pending')::int    AS pending_count,
            COUNT(*) FILTER (WHERE h.status = 'resolved')::int   AS resolved_count,
            COUNT(*) FILTER (WHERE h.status = 'closed')::int     AS closed_count
       FROM handled h
      GROUP BY h.assigned_staff_id`,
    [from, to, timezone]
  );
  return result.rows;
}

/**
 * Outbound messages successfully sent by each staff member in the period.
 * Includes plain text, quick replies, templates, media and forwards — every
 * real outbound message the CRM sent — keyed to its sender. Webhook status
 * updates never create new messages and the Away Message / auto reply have
 * sent_by_staff_id NULL, so none of those can appear here.
 */
export async function agentMessagesSent(from, to, timezone) {
  const result = await query(
    `WITH bounds(lo, hi) AS (
       SELECT (($1::date)::timestamp AT TIME ZONE $3),
              ((($2::date) + 1)::timestamp AT TIME ZONE $3)
     )
     SELECT m.sent_by_staff_id AS staff_id, COUNT(*)::int AS messages_sent
       FROM messages m
      WHERE ${SENT_OUTBOUND}
        AND m.created_at >= (SELECT lo FROM bounds)
        AND m.created_at <  (SELECT hi FROM bounds)
      GROUP BY m.sent_by_staff_id`,
    [from, to, timezone]
  );
  return result.rows;
}

/**
 * Real response times (§7/§8).
 *
 * For every eligible customer inbound message in the period we find the FIRST
 * successfully-sent outbound message by an actual staff member afterwards:
 *
 *   A. a run of customer messages is answered once — the pair is built from
 *      the FIRST unanswered inbound of the run (the previous message in the
 *      thread is outbound or there is none) to the first staff response;
 *   B. if there is no response yet the inbound is dropped (never 0 seconds);
 *   C. the Away Message / auto reply have no sender, so they can never be a
 *      response;
 *   D/E. quick replies and approved templates are real outbound rows and do
 *      count;
 *   F. failed rows are excluded.
 *
 * Pairs are attributed to the conversation's CURRENT assigned agent — the
 * person accountable for the thread under the existing ownership rules — so an
 * admin reply written into an agent's conversation still counts as that
 * agent's response time.
 */
export async function agentResponseStats(from, to, timezone) {
  const result = await query(
    `WITH bounds(lo, hi) AS (
       SELECT (($1::date)::timestamp AT TIME ZONE $3),
              ((($2::date) + 1)::timestamp AT TIME ZONE $3)
     ),
     scope AS (
       SELECT DISTINCT c.id, c.assigned_staff_id
         FROM conversations c
        WHERE c.assigned_staff_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM messages m
                       WHERE m.conversation_id = c.id
                         AND m.created_at >= (SELECT lo FROM bounds)
                         AND m.created_at <  (SELECT hi FROM bounds))
     ),
     inbound AS (
       SELECT m.id AS inb_id,
              m.conversation_id,
              m.created_at AS inb_at,
              sc.assigned_staff_id,
              (SELECT q.direction
                 FROM messages q
                WHERE q.conversation_id = m.conversation_id
                  AND (q.created_at < m.created_at
                       OR (q.created_at = m.created_at AND q.id < m.id))
                ORDER BY q.created_at DESC, q.id DESC
                LIMIT 1) AS prev_dir
         FROM messages m
         JOIN scope sc ON sc.id = m.conversation_id
        WHERE m.direction = 'inbound'
          AND m.created_at >= (SELECT lo FROM bounds)
          AND m.created_at <  (SELECT hi FROM bounds)
     ),
     run_start AS (
       SELECT inbound.*
         FROM inbound
        WHERE inbound.prev_dir IS DISTINCT FROM 'inbound'
     ),
     paired AS (
       SELECT i.assigned_staff_id AS agent_id,
              i.inb_at,
              (SELECT MIN(o.created_at)
                 FROM messages o
                WHERE o.conversation_id = i.conversation_id
                  AND o.direction = 'outbound'
                  AND o.sent_by_staff_id IS NOT NULL
                  AND o.status NOT IN ('failed', 'queued', 'pending')
                  AND (o.created_at > i.inb_at
                       OR (o.created_at = i.inb_at AND o.id > i.inb_id))) AS resp_at
         FROM run_start i
     )
     SELECT p.agent_id,
            COUNT(*)::int AS response_count,
            COALESCE(SUM(EXTRACT(EPOCH FROM (p.resp_at - p.inb_at))), 0)::double precision AS total_seconds
       FROM paired p
      WHERE p.resp_at IS NOT NULL
      GROUP BY p.agent_id`,
    [from, to, timezone]
  );
  return result.rows;
}

/**
 * Daily breakdown for one agent (§13): per calendar day in the app timezone,
 * how many distinct conversations they handled, distinct customers, and the
 * messages they sent. Days with no activity appear with honest zeros.
 */
export async function agentDailyBreakdown(agentId, from, to, timezone) {
  const result = await query(
    `WITH bounds(lo, hi) AS (
       SELECT (($2::date)::timestamp AT TIME ZONE $4),
              ((($3::date) + 1)::timestamp AT TIME ZONE $4)
     ),
     days AS (
       SELECT generate_series(
                (SELECT (lo AT TIME ZONE $4)::date FROM bounds),
                (SELECT (hi AT TIME ZONE $4)::date - 1 FROM bounds),
                interval '1 day'
              )::date AS day
     ),
     day_msgs AS (
       SELECT m.id, m.conversation_id, m.direction, m.status, m.sent_by_staff_id, m.created_at
         FROM messages m, bounds b
        WHERE m.created_at >= b.lo AND m.created_at < b.hi
     ),
     bucketed AS (
       SELECT (dm.created_at AT TIME ZONE $4)::date AS day,
              dm.conversation_id,
              dm.direction,
              dm.status,
              dm.sent_by_staff_id
         FROM day_msgs dm
     ),
     agg AS (
       SELECT b.day,
              COUNT(DISTINCT c.id)::int                                   AS chats_handled,
              COUNT(DISTINCT c.contact_id)::int                           AS customers,
              COUNT(*) FILTER (WHERE b.direction = 'outbound'
                    AND b.status NOT IN ('failed', 'queued', 'pending')
                    AND b.sent_by_staff_id = $1)::int                     AS messages_sent
         FROM bucketed b
         JOIN conversations c ON c.id = b.conversation_id
          AND c.assigned_staff_id = $1
        GROUP BY b.day
     )
     SELECT to_char((d.day)::date, 'YYYY-MM-DD') AS day,
            COALESCE(a.chats_handled, 0)::int AS chats_handled,
            COALESCE(a.customers, 0)::int     AS customers,
            COALESCE(a.messages_sent, 0)::int AS messages_sent
       FROM days d
       LEFT JOIN agg a ON a.day = (d.day)::date
      ORDER BY day, (d.day)::date`,
    [agentId, from, to, timezone]
  );
  return result.rows;
}