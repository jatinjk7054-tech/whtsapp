import { Router } from 'express';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate } from '../middleware/auth.js';
import { listNotificationsQuery, notificationIdParam } from './notification.schema.js';
import * as notificationService from './notification.service.js';

/**
 * Module 10 — the header bell. Every route is scoped to the logged-in staff
 * member; there is no way to read or mutate another person's notifications.
 */
export const notificationRouter = Router();

notificationRouter.use(authenticate);

/** GET /notifications — sweeps due reminders, returns feed + unread count. */
notificationRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const opts = listNotificationsQuery.parse(req.query);
    res.json(await notificationService.listForStaff(req.staff, opts));
  })
);

/** POST /notifications/read-all */
notificationRouter.post(
  '/read-all',
  asyncRoute(async (req, res) => {
    res.json(await notificationService.markEverythingRead(req.staff));
  })
);

/** POST /notifications/:id/read */
notificationRouter.post(
  '/:id/read',
  asyncRoute(async (req, res) => {
    const { id } = notificationIdParam.parse(req.params);
    res.json(await notificationService.markOneRead(req.staff, id));
  })
);
