import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/pool.js';

/**
 * Module 9 — persistence for the automation settings, keyword rules, per-rule
 * cooldown state and the automation log. Nothing here touches conversation
 * assignment: ownership stays exactly as the existing modules left it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const automationSchemaPath = path.join(here, '..', 'db', 'automation.schema.sql');

/** Applies automation.schema.sql and seeds the single settings row. Idempotent. */
export async function ensureAutomationSchema() {
  const sql = await readFile(automationSchemaPath, 'utf8');
  await query(sql);
  await query(
    `INSERT INTO automation_settings (id, enabled, send_away_and_keyword)
     VALUES (1, FALSE, FALSE)
     ON CONFLICT (id) DO NOTHING`
  );
}

function normalizeSettings(row) {
  if (!row) return null;
  return {
    id: row.id,
    enabled: Boolean(row.enabled),
    sendAwayAndKeyword: Boolean(row.send_away_and_keyword),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getAutomationSettings() {
  const result = await query('SELECT * FROM automation_settings WHERE id = 1');
  if (result.rows[0]) return normalizeSettings(result.rows[0]);

  // A webhook can beat the boot-time seed on a brand-new database.
  await ensureAutomationSchema();
  const retry = await query('SELECT * FROM automation_settings WHERE id = 1');
  return normalizeSettings(retry.rows[0]);
}

export async function updateAutomationSettings({ enabled, sendAwayAndKeyword }) {
  const result = await query(
    `UPDATE automation_settings
        SET enabled               = COALESCE($1, enabled),
            send_away_and_keyword = COALESCE($2, send_away_and_keyword),
            updated_at            = NOW()
      WHERE id = 1
      RETURNING *`,
    [
      enabled === undefined ? null : Boolean(enabled),
      sendAwayAndKeyword === undefined ? null : Boolean(sendAwayAndKeyword),
    ]
  );
  return normalizeSettings(result.rows[0]);
}

/* ------------------------------------------------------------------ rules -- */

const RULE_COLUMNS = `
  r.id, r.name, r.keyword, r.match_type, r.reply_text, r.enabled, r.tag_id,
  r.priority, r.cooldown_seconds, r.template_name, r.template_language,
  r.created_by, r.created_at, r.updated_at,
  t.name AS tag_name, t.color AS tag_color
`;

const RULE_FROM = `
  FROM automation_rules r
  LEFT JOIN tags t ON t.id = r.tag_id
`;

export async function listRules({ includeDisabled = true } = {}) {
  const result = await query(
    `SELECT ${RULE_COLUMNS} ${RULE_FROM}
     ${includeDisabled ? '' : 'WHERE r.enabled = TRUE'}
     ORDER BY r.priority DESC, r.id ASC`
  );
  return result.rows;
}

/** Rules the webhook evaluates: enabled only, highest priority first. */
export function listEnabledRules() {
  return listRules({ includeDisabled: false });
}

export async function getRuleById(id) {
  const result = await query(`SELECT ${RULE_COLUMNS} ${RULE_FROM} WHERE r.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findRuleByName(name, exceptId = null) {
  const result = await query(
    `SELECT id, name FROM automation_rules
      WHERE LOWER(name) = LOWER($1) AND ($2::int IS NULL OR id <> $2)`,
    [String(name).trim(), exceptId]
  );
  return result.rows[0] ?? null;
}

export async function createRule(
  {
    name,
    keyword,
    matchType,
    replyText,
    enabled,
    tagId,
    priority,
    cooldownSeconds,
    templateName,
    templateLanguage,
  },
  createdBy = null
) {
  const result = await query(
    `INSERT INTO automation_rules
       (name, keyword, match_type, reply_text, enabled, tag_id, priority,
        cooldown_seconds, template_name, template_language, created_by)
     VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), $6, COALESCE($7, 0),
             COALESCE($8, 0), $9, $10, $11)
     RETURNING id`,
    [
      name,
      keyword,
      matchType ?? 'contains',
      replyText,
      enabled === undefined ? null : Boolean(enabled),
      tagId ?? null,
      priority ?? null,
      cooldownSeconds ?? null,
      templateName ?? null,
      templateLanguage ?? null,
      createdBy,
    ]
  );
  return getRuleById(result.rows[0].id);
}

/** Partial update — omitted fields keep their current value. */
export async function updateRule(
  id,
  {
    name,
    keyword,
    matchType,
    replyText,
    enabled,
    tagId,
    priority,
    cooldownSeconds,
    templateName,
    templateLanguage,
  }
) {
  const result = await query(
    `UPDATE automation_rules
        SET name              = COALESCE($2, name),
            keyword           = COALESCE($3, keyword),
            match_type        = COALESCE($4, match_type),
            reply_text        = COALESCE($5, reply_text),
            enabled           = COALESCE($6, enabled),
            tag_id            = CASE WHEN $7::boolean THEN $8::int ELSE tag_id END,
            priority          = COALESCE($9, priority),
            cooldown_seconds  = COALESCE($10, cooldown_seconds),
            template_name     = CASE WHEN $11::boolean THEN $12::text ELSE template_name END,
            template_language = CASE WHEN $13::boolean THEN $14::text ELSE template_language END,
            updated_at        = NOW()
      WHERE id = $1
      RETURNING id`,
    [
      id,
      name ?? null,
      keyword ?? null,
      matchType ?? null,
      replyText ?? null,
      enabled === undefined ? null : Boolean(enabled),
      tagId !== undefined,
      tagId ?? null,
      priority ?? null,
      cooldownSeconds ?? null,
      templateName !== undefined,
      templateName ?? null,
      templateLanguage !== undefined,
      templateLanguage ?? null,
    ]
  );
  if (result.rowCount === 0) return null;
  return getRuleById(id);
}

export async function deleteRule(id) {
  const result = await query('DELETE FROM automation_rules WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

/* --------------------------------------------------------------- cooldown -- */

/**
 * Claims the right to send `rule_id` to `conversation_id`. With a cooldown the
 * conditional upsert makes concurrent webhooks race for exactly one winner;
 * with 0 it still records the send so the state table stays meaningful. Returns
 * true when this caller owns the send.
 */
export async function claimRuleCooldown(conversationId, ruleId, cooldownSeconds) {
  const seconds = Math.max(0, Number(cooldownSeconds) || 0);

  if (seconds === 0) {
    await query(
      `INSERT INTO automation_rule_state (conversation_id, rule_id, last_sent_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (conversation_id, rule_id) DO UPDATE SET last_sent_at = NOW()`,
      [conversationId, ruleId]
    );
    return true;
  }

  const result = await query(
    `INSERT INTO automation_rule_state (conversation_id, rule_id, last_sent_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (conversation_id, rule_id) DO UPDATE SET last_sent_at = NOW()
      WHERE automation_rule_state.last_sent_at < NOW() - ($3::int * INTERVAL '1 second')
     RETURNING rule_id`,
    [conversationId, ruleId, seconds]
  );
  return result.rowCount > 0;
}

/** Gives the cooldown back when the send never went out, so a retry can happen. */
export async function releaseRuleCooldown(conversationId, ruleId) {
  await query(
    'DELETE FROM automation_rule_state WHERE conversation_id = $1 AND rule_id = $2',
    [conversationId, ruleId]
  );
}

/* ------------------------------------------------------------------- logs -- */

const LOG_SELECT = `
  SELECT l.id, l.created_at, l.action, l.result, l.conversation_id, l.contact_id,
         l.trigger_message_id, l.message_id, l.rule_id, l.rule_name, l.detail,
         l.wa_message_id,
         ct.wa_id AS contact_wa_id, ct.name AS contact_name,
         c.status AS conversation_status
    FROM automation_logs l
    LEFT JOIN conversations c ON c.id = l.conversation_id
    LEFT JOIN contacts ct ON ct.id = COALESCE(l.contact_id, c.contact_id)
`;

/**
 * Inserts a finished log row (away messages, blocked/skipped keyword replies).
 * Safe error text only — callers pass `error.message`, never a token.
 */
export async function insertAutomationLog({
  action,
  result,
  conversationId = null,
  contactId = null,
  triggerMessageId = null,
  messageId = null,
  ruleId = null,
  ruleName = null,
  detail = null,
  waMessageId = null,
}) {
  const res = await query(
    `INSERT INTO automation_logs
       (action, result, conversation_id, contact_id, trigger_message_id,
        message_id, rule_id, rule_name, detail, wa_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      action,
      result,
      conversationId,
      contactId,
      triggerMessageId,
      messageId,
      ruleId,
      ruleName,
      detail,
      waMessageId,
    ]
  );
  return res.rows[0].id;
}

/**
 * Reservers a keyword-reply log *before* sending. The partial unique index on
 * (trigger_message_id, rule_id) makes a redelivered webhook lose here, so the
 * reply can never be sent twice. Returns the log id, or null for a duplicate.
 */
export async function claimKeywordReplyLog({
  conversationId,
  contactId,
  triggerMessageId,
  ruleId,
  ruleName,
}) {
  const res = await query(
    `INSERT INTO automation_logs
       (action, result, conversation_id, contact_id, trigger_message_id, rule_id, rule_name)
     VALUES ('keyword_reply', 'processing', $1, $2, $3, $4, $5)
     ON CONFLICT (trigger_message_id, rule_id) WHERE action = 'keyword_reply' DO NOTHING
     RETURNING id`,
    [conversationId, contactId, triggerMessageId, ruleId, ruleName]
  );
  return res.rows[0]?.id ?? null;
}

export async function finalizeAutomationLog(id, { result, detail = null, messageId = null, waMessageId = null } = {}) {
  await query(
    `UPDATE automation_logs
        SET result = $2, detail = $3, message_id = $4, wa_message_id = $5
      WHERE id = $1`,
    [id, result, detail, messageId, waMessageId]
  );
}

export async function listAutomationLogs({
  from,
  to,
  ruleId,
  action,
  result,
  timezone = 'Asia/Kolkata',
  limit = 50,
  offset = 0,
} = {}) {
  const conditions = [];
  const values = [];

  // The application timezone is only bound when a date filter needs it, so
  // "today" means the same calendar day as everywhere else in the product
  // without leaving an unused parameter behind (Postgres rejects those).
  let tzParam = null;
  const tzRef = () => {
    if (tzParam === null) tzParam = values.push(timezone);
    return `$${tzParam}`;
  };

  if (from) {
    const fromIdx = values.push(from);
    conditions.push(`(l.created_at AT TIME ZONE ${tzRef()})::date >= $${fromIdx}::date`);
  }
  if (to) {
    const toIdx = values.push(to);
    conditions.push(`(l.created_at AT TIME ZONE ${tzRef()})::date <= $${toIdx}::date`);
  }
  if (ruleId !== undefined && ruleId !== null) {
    values.push(ruleId);
    conditions.push(`l.rule_id = $${values.length}`);
  }
  if (action) {
    values.push(action);
    conditions.push(`l.action = $${values.length}`);
  }
  if (result) {
    values.push(result);
    conditions.push(`l.result = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageValues = [
    ...values,
    Math.min(Math.max(Number(limit) || 50, 1), 200),
    Math.max(Number(offset) || 0, 0),
  ];

  const items = await query(
    `${LOG_SELECT} ${where}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    pageValues
  );

  const total = await query(
    `SELECT COUNT(*)::int AS total FROM automation_logs l ${where}`,
    values
  );

  return { items: items.rows, total: total.rows[0].total };
}
