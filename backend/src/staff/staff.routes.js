import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { listAssignmentLoad, listStaff, updateStaff } from './staff.repository.js';
import { changePassword, login, registerStaff, adminUpdateStaff } from './staff.service.js';

export const staffRouter = Router();

const credentials = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
});

const createStaffBody = credentials.extend({
  name: z.string().trim().min(1).max(120),
  role: z.enum(['admin', 'agent']).optional(),
});

const updateStaffBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().optional(),
  role: z.enum(['admin', 'agent']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

staffRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    res.json(await login(credentials.parse(req.body)));
  })
);

staffRouter.get(
  '/me',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json(req.staff);
  })
);

staffRouter.post(
  '/me/password',
  authenticate,
  asyncRoute(async (req, res) => {
    res.json(await changePassword(req.staff.id, changePasswordBody.parse(req.body)));
  })
);

staffRouter.get(
  '/',
  authenticate,
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    res.json({ items: await listStaff({ includeInactive }) });
  })
);

staffRouter.get(
  '/assignments',
  authenticate,
  requireRole('admin'),
  asyncRoute(async (_req, res) => {
    res.json({ items: await listAssignmentLoad() });
  })
);

staffRouter.post(
  '/',
  authenticate,
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    res.status(201).json(await registerStaff(createStaffBody.parse(req.body)));
  })
);

staffRouter.patch(
  '/:id',
  authenticate,
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const updated = await adminUpdateStaff(id, updateStaffBody.parse(req.body));
    if (!updated) throw new HttpError(404, 'Staff member not found');
    res.json(updated);
  })
);