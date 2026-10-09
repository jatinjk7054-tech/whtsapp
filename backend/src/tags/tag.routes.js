import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { createTag, deleteTag, findTagByName, listTags, updateTag } from './tag.repository.js';

export const tagRouter = Router();

tagRouter.use(authenticate);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const createBody = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().trim().regex(HEX_COLOR, 'Colour must be a #rrggbb hex value').optional(),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: z.string().trim().regex(HEX_COLOR, 'Colour must be a #rrggbb hex value').optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: 'Provide a name or a colour to update',
  });

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * GET /api/tags — the tag catalogue (filter menu, profile selector, admin UI).
 * Any signed-in staff may read it: agents need the list to filter and to tag
 * their own customers.
 */
tagRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    res.json({ items: await listTags() });
  })
);

/**
 * POST /api/tags — create a custom tag. Allowed for agents as well as admins
 * because the "+ Create New Tag" step of tagging a customer has to work for
 * whoever owns the conversation; renaming and deleting stay admin-only below,
 * which is what the existing permission system (admin | agent) allows.
 */
tagRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { name, color } = createBody.parse(req.body);

    const existing = await findTagByName(name);
    if (existing) throw new HttpError(409, `Tag "${existing.name}" already exists`);

    res.status(201).json(await createTag({ name, color }));
  })
);

/** PATCH /api/tags/:id — rename / recolour. Admin only (§16). */
tagRouter.patch(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const patch = updateBody.parse(req.body);

    if (patch.name) {
      const existing = await findTagByName(patch.name);
      if (existing && existing.id !== id) {
        throw new HttpError(409, `Tag "${existing.name}" already exists`);
      }
    }

    const updated = await updateTag(id, patch);
    if (!updated) throw new HttpError(404, 'Tag not found');

    res.json(updated);
  })
);

/**
 * DELETE /api/tags/:id — admin only (§16). The relationship rows are removed
 * by the FK cascade; customers and conversations are never deleted.
 */
tagRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const deleted = await deleteTag(id);
    if (!deleted) throw new HttpError(404, 'Tag not found');

    res.json(deleted);
  })
);
