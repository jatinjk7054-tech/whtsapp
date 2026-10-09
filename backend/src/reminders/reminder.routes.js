import { Router } from 'express';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate } from '../middleware/auth.js';
import { createReminderBody, listRemindersQuery, reminderIdParam, updateReminderBody } from './reminder.schema.js';
import * as reminderService from './reminder.service.js';

/**
 * Module 10 — follow-up reminders. Both roles may use reminders; the service
 * layer enforces that an agent only touches conversations assigned to them.
 */
export const reminderRouter = Router();

reminderRouter.use(authenticate);

/** GET /reminders — filtered, searched, paginated dashboard list + counts. */
reminderRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const filters = listRemindersQuery.parse(req.query);
    res.json(await reminderService.list(req.staff, filters));
  })
);

/** POST /reminders — set a follow-up on a conversation. */
reminderRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = createReminderBody.parse(req.body);
    const reminder = await reminderService.create(req.staff, parsed);
    res.status(201).json(reminder);
  })
);

/** GET /reminders/:id */
reminderRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = reminderIdParam.parse(req.params);
    res.json(await reminderService.get(req.staff, id));
  })
);

/** PATCH /reminders/:id — reschedule/edit a pending reminder. */
reminderRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = reminderIdParam.parse(req.params);
    const parsed = updateReminderBody.parse(req.body);
    res.json(await reminderService.update(req.staff, id, parsed));
  })
);

/** POST /reminders/:id/complete */
reminderRouter.post(
  '/:id/complete',
  asyncRoute(async (req, res) => {
    const { id } = reminderIdParam.parse(req.params);
    res.json(await reminderService.changeStatus(req.staff, id, 'complete'));
  })
);

/** POST /reminders/:id/cancel */
reminderRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    const { id } = reminderIdParam.parse(req.params);
    res.json(await reminderService.changeStatus(req.staff, id, 'cancel'));
  })
);

/** POST /reminders/:id/reopen — move a completed/cancelled reminder back. */
reminderRouter.post(
  '/:id/reopen',
  asyncRoute(async (req, res) => {
    const { id } = reminderIdParam.parse(req.params);
    res.json(await reminderService.changeStatus(req.staff, id, 'reopen'));
  })
);
