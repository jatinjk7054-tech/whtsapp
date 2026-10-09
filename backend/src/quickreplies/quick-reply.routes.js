import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { query } from '../db/pool.js';
import {
  createQuickReply,
  deleteQuickReply,
  findQuickReplyByShortcut,
  getQuickReplyById,
  listQuickReplies,
  normalizeShortcut,
  QUICK_REPLY_CATEGORIES,
  updateQuickReply,
} from './quick-reply.repository.js';

export const quickReplyRouter = Router();

quickReplyRouter.use(authenticate);

const shortcutShape = z
  .string()
  .trim()
  .min(1, 'Shortcut is required')
  .max(40, 'Shortcut must be 40 characters or fewer')
  .regex(
    /^\/?[A-Za-z0-9._-]+$/,
    'Use a shortcut like /donation — letters, numbers, dots, dashes or underscores, with no spaces'
  );

const createBody = z.object({
  title: z.string().trim().min(1, 'Title is required').max(80),
  shortcut: shortcutShape,
  category: z.string().trim().max(40).optional(),
  message: z.string().trim().min(1, 'Message cannot be empty').max(4000),
});

const updateBody = createBody.partial().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: 'Provide at least one field to update' }
);

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Distinct categories in use, plus the suggested ones, for the filter dropdowns. */
async function categoriesInUse() {
  const result = await query('SELECT DISTINCT category FROM quick_replies ORDER BY category');
  const fromDb = result.rows.map((row) => row.category).filter(Boolean);
  return [...new Set([...QUICK_REPLY_CATEGORIES, ...fromDb])];
}

async function assertFreeShortcut(shortcut, exceptId = null) {
  const existing = await findQuickReplyByShortcut(shortcut, exceptId);
  if (existing) throw new HttpError(409, `Shortcut "${existing.shortcut}" is already in use`);
}

/**
 * GET — the whole library. Agents get this too: they search and use quick
 * replies, they just cannot change them.
 */
quickReplyRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    res.json({
      items: await listQuickReplies(search),
      categories: await categoriesInUse(),
    });
  })
);

/** POST — Admin only. Agents cannot add to the shared library. */
quickReplyRouter.post(
  '/',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const parsed = createBody.parse(req.body);
    const shortcut = normalizeShortcut(parsed.shortcut);

    await assertFreeShortcut(shortcut);

    try {
      const created = await createQuickReply(
        { ...parsed, shortcut },
        req.staff?.id ?? null
      );
      res.status(201).json(created);
    } catch (error) {
      // Unique index on LOWER(shortcut): two admins racing the same name.
      if (error?.code === '23505') throw new HttpError(409, `Shortcut "${shortcut}" is already in use`);
      throw error;
    }
  })
);

/** PATCH — Admin only (rename, recategorise, rewrite, re-shortcut). */
quickReplyRouter.patch(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const parsed = updateBody.parse(req.body);

    const existing = await getQuickReplyById(id);
    if (!existing) throw new HttpError(404, 'Quick reply not found');

    if (parsed.shortcut !== undefined) {
      await assertFreeShortcut(normalizeShortcut(parsed.shortcut), id);
    }

    try {
      const updated = await updateQuickReply(id, parsed);
      res.json(updated);
    } catch (error) {
      if (error?.code === '23505') {
        throw new HttpError(409, `Shortcut "${normalizeShortcut(parsed.shortcut)}" is already in use`);
      }
      throw error;
    }
  })
);

/** DELETE — Admin only. Agents' copies of the library refresh automatically. */
quickReplyRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    if (!(await deleteQuickReply(id))) throw new HttpError(404, 'Quick reply not found');
    res.json({ id });
  })
);
