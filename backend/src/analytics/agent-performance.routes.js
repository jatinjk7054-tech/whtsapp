import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getAgentPerformance, getAgentPerformanceDetail } from './agent-performance.service.js';

/**
 * Module 8 — Agent Performance Analytics. Every route on this router is
 * Admin-only (the middleware pair below, not the frontend, is the gate). An
 * agent calling any of these endpoints gets a 403 before any query runs.
 */
export const agentPerformanceRouter = Router();

agentPerformanceRouter.use(authenticate, requireRole('admin'));

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD');

const listQuery = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
  agentId: z.coerce.number().int().positive().optional(),
  sort: z
    .enum(['chats', 'messages', 'customers', 'response', 'open', 'pending', 'resolved', 'closed'])
    .optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const detailParams = z.object({
  id: z.coerce.number().int().positive(),
});

agentPerformanceRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json(await getAgentPerformance(listQuery.parse(req.query)));
  })
);

agentPerformanceRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = detailParams.parse(req.params);
    const { from, to } = listQuery.pick({ from: true, to: true }).parse(req.query);
    res.json(await getAgentPerformanceDetail(id, { from, to }));
  })
);