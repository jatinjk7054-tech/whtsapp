import { Router } from 'express';
import { authenticate } from './middleware/auth.js';
import { asyncRoute } from './middleware/asyncRoute.js';
import { listApprovedTemplates } from './lib/whatsapp/client.js';

export const whatsappRouter = Router();
whatsappRouter.use(authenticate);
whatsappRouter.get('/templates', asyncRoute(async (_req, res) => {
  res.json(await listApprovedTemplates());
}));
