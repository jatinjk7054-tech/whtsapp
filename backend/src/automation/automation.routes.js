import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { query } from '../db/pool.js';
import { getAnalyticsTimezone } from '../analytics/agent-performance.repository.js';
import { MATCH_TYPES } from './match.js';
import { previewAutomation } from './automation.service.js';
import {
  createRule,
  deleteRule,
  findRuleByName,
  getAutomationSettings,
  getRuleById,
  listAutomationLogs,
  listRules,
  updateAutomationSettings,
  updateRule,
} from './automation.repository.js';

export const automationRouter = Router();

// Module 9: automation is a global, Admin-only feature. Agents are refused in
// the backend, not merely by hiding a button.
automationRouter.use(authenticate);
automationRouter.use(requireRole('admin'));

/* ------------------------------------------------------------- settings -- */

const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    sendAwayAndKeyword: z.boolean().optional(),
  })
  .refine((value) => value.enabled !== undefined || value.sendAwayAndKeyword !== undefined, {
    message: 'Provide at least one setting to update',
  });

automationRouter.get(
  '/settings',
  asyncRoute(async (_req, res) => {
    res.json({ settings: await getAutomationSettings() });
  })
);

automationRouter.put(
  '/settings',
  asyncRoute(async (req, res) => {
    const parsed = settingsBody.parse(req.body);
    const settings = await updateAutomationSettings(parsed);
    res.json({ settings });
  })
);

/* ---------------------------------------------------------------- rules -- */

const MATCH_ENUM = z.enum(MATCH_TYPES);
const optionalTemplateName = z.string().trim().max(200).nullable().optional();
const optionalTemplateLanguage = z.string().trim().max(20).nullable().optional();

const baseRule = z.object({
  name: z.string().trim().min(1, 'Rule name is required').max(80),
  keyword: z.string().trim().min(1, 'Keyword is required').max(200),
  matchType: MATCH_ENUM.optional(),
  replyText: z.string().trim().min(1, 'Reply text is required').max(4000),
  enabled: z.boolean().optional(),
  tagId: z.number().int().positive().nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  templateName: optionalTemplateName,
  templateLanguage: optionalTemplateLanguage,
});

/** A template is all-or-nothing: name and language must be supplied together. */
function checkTemplatePair(value, ctx) {
  const hasName = Boolean(value.templateName);
  const hasLanguage = Boolean(value.templateLanguage);
  if (hasName !== hasLanguage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Template name and language must be provided together',
      path: ['templateName'],
    });
  }
}

const createBody = baseRule.superRefine(checkTemplatePair);
const updateBody = baseRule.partial().superRefine(checkTemplatePair);

const idParam = z.object({ id: z.coerce.number().int().positive() });

async function assertFreeName(name, exceptId = null) {
  const existing = await findRuleByName(name, exceptId);
  if (existing) throw new HttpError(409, `A rule named "${existing.name}" already exists`);
}

async function assertTagExists(tagId) {
  if (tagId === undefined || tagId === null) return;
  const result = await query('SELECT id FROM tags WHERE id = $1', [tagId]);
  if (result.rowCount === 0) throw new HttpError(422, 'The selected tag does not exist');
}

/** GET /rules — every rule the Admin maintains, highest priority first. */
automationRouter.get(
  '/rules',
  asyncRoute(async (_req, res) => {
    res.json({ items: await listRules() });
  })
);

/** POST /rules — create a keyword rule. */
automationRouter.post(
  '/rules',
  asyncRoute(async (req, res) => {
    const parsed = createBody.parse(req.body);
    await assertFreeName(parsed.name);
    await assertTagExists(parsed.tagId);

    try {
      const created = await createRule(parsed, req.staff?.id ?? null);
      res.status(201).json(created);
    } catch (error) {
      if (error?.code === '23505') throw new HttpError(409, 'A rule with this name already exists');
      throw error;
    }
  })
);

/** PATCH /rules/:id — partial update. */
automationRouter.patch(
  '/rules/:id',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const parsed = updateBody.parse(req.body);

    const existing = await getRuleById(id);
    if (!existing) throw new HttpError(404, 'Automation rule not found');

    if (parsed.name !== undefined) await assertFreeName(parsed.name, id);
    if (parsed.tagId !== undefined) await assertTagExists(parsed.tagId);

    try {
      const updated = await updateRule(id, parsed);
      res.json(updated);
    } catch (error) {
      if (error?.code === '23505') throw new HttpError(409, 'A rule with this name already exists');
      throw error;
    }
  })
);

/** DELETE /rules/:id */
automationRouter.delete(
  '/rules/:id',
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    if (!(await deleteRule(id))) throw new HttpError(404, 'Automation rule not found');
    res.json({ id });
  })
);

/* ----------------------------------------------------------------- test -- */

const testBody = z
  .object({
    text: z.string().max(4000).default(''),
    keyword: z.string().trim().max(200).optional(),
    matchType: MATCH_ENUM.optional(),
    replyText: z.string().max(4000).optional(),
  })
  .refine((value) => value.text.length > 0, { message: 'Provide the message text to test' });

/**
 * POST /test — simulation only. Runs the exact matching code the webhook uses
 * against saved rules (or an unsaved draft) and returns which rule would win.
 * Nothing is written and no WhatsApp message is ever sent.
 */
automationRouter.post(
  '/test',
  asyncRoute(async (req, res) => {
    const parsed = testBody.parse(req.body);

    const draft = parsed.keyword
      ? [
          {
            id: null,
            name: '(draft)',
            keyword: parsed.keyword,
            match_type: parsed.matchType ?? 'contains',
            reply_text: parsed.replyText ?? '',
            template_name: null,
            template_language: null,
          },
        ]
      : null;

    const result = await previewAutomation(parsed.text, draft);
    res.json({ simulated: true, sent: false, ...result });
  })
);

/* ----------------------------------------------------------------- logs -- */

const logsQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ruleId: z.coerce.number().int().positive().optional(),
  action: z.enum(['keyword_reply', 'away_message']).optional(),
  result: z.enum(['processing', 'sent', 'failed', 'skipped', 'blocked']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** GET /logs — the automation audit trail, newest first, with filters. */
automationRouter.get(
  '/logs',
  asyncRoute(async (req, res) => {
    const filters = logsQuery.parse(req.query);
    // Boundaries are measured in the same application timezone analytics uses.
    const result = await listAutomationLogs({ ...filters, timezone: await getAnalyticsTimezone() });
    res.json(result);
  })
);
