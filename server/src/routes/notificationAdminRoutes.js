import { Router } from 'express';
import {
  sendNow,
  scheduleNotification,
  listScheduledNotifications,
  cancelScheduled,
  removeScheduled,
} from '../controllers/notificationAdminController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHr = authenticateRole('super_admin', 'admin', 'hr');

router.post('/send-now', adminOrHr, sendNow);
router.post('/schedule', adminOrHr, scheduleNotification);
router.get('/scheduled', adminOrHr, listScheduledNotifications);
router.put('/scheduled/:id/cancel', adminOrHr, cancelScheduled);
router.delete('/scheduled/:id', adminOrHr, removeScheduled);

export default router;
