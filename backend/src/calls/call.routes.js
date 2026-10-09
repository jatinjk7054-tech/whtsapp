import { Router } from 'express';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate } from '../middleware/auth.js';
import { answerCallBody, callIdParam } from './call.schema.js';
import * as callService from './call.service.js';

/**
 * Module 12 — WhatsApp voice calling.
 *
 * Global call actions live here; conversation-scoped listing/starting lives on
 * the conversation router (`/conversations/:id/calls`) so the ownership check is
 * shared with the rest of the thread. Every route requires a signed-in staff
 * member and the service enforces conversation ownership.
 */
export const callRouter = Router();

callRouter.use(authenticate);

/** GET /calls/status — feature/eligibility configuration + setup checklist. */
callRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    res.json(callService.getConfiguration());
  })
);

/** GET /calls/incoming — inbound calls currently ringing for this staff member. */
callRouter.get(
  '/incoming',
  asyncRoute(async (req, res) => {
    res.json(await callService.listIncoming(req.staff));
  })
);

/** GET /calls/:id — one call, with SDP only for its participants. */
callRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = callIdParam.parse(req.params);
    res.json(await callService.getCall(req.staff, id));
  })
);

/** POST /calls/:id/answer — accept an inbound call with the browser's answer. */
callRouter.post(
  '/:id/answer',
  asyncRoute(async (req, res) => {
    const { id } = callIdParam.parse(req.params);
    const { sdpAnswer } = answerCallBody.parse(req.body);
    res.json(await callService.answerInbound(req.staff, id, { sdpAnswer }));
  })
);

/** POST /calls/:id/reject — decline an inbound call. */
callRouter.post(
  '/:id/reject',
  asyncRoute(async (req, res) => {
    const { id } = callIdParam.parse(req.params);
    res.json(await callService.rejectInbound(req.staff, id));
  })
);

/** POST /calls/:id/terminate — hang up. */
callRouter.post(
  '/:id/terminate',
  asyncRoute(async (req, res) => {
    const { id } = callIdParam.parse(req.params);
    res.json(await callService.terminate(req.staff, id));
  })
);
