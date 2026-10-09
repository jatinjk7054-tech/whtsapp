import { Router } from 'express';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';
import {
  registerToken,
  getNotifications,
  markRead,
  getUnreadCount,
  sendTestNotification,
  deleteNotification,
  getNotificationLeadInfo,
  sendSuspenseAlert,
  sendFroAction,
  listEntertainmentAudios,
  uploadEntertainmentAudio,
  sendFroBroadcast,
  sendFroTeamBroadcast,
} from '../controllers/notificationController.js';

const router = Router();

router.post('/register-token', authenticate, registerToken);
router.post('/test-send', authenticateRole('super_admin', 'admin', 'hr'), sendTestNotification);
router.post('/suspense-alert', authenticateRole('accounts', 'super_admin', 'admin'), sendSuspenseAlert);
router.post('/fro-action', authenticateRole('accounts', 'super_admin', 'admin'), sendFroAction);
router.get('/entertain-audios', authenticateRole('accounts', 'super_admin', 'admin'), listEntertainmentAudios);
router.post('/entertain-audios', authenticateRole('accounts', 'super_admin', 'admin'), uploadEntertainmentAudio);
router.post('/fro-broadcast', authenticateRole('accounts', 'super_admin', 'admin'), sendFroBroadcast);
router.post('/fro-team-broadcast', authenticateRole('accounts', 'super_admin', 'admin'), sendFroTeamBroadcast);
router.get('/:worker_id', authenticate, getNotifications);
router.get('/:worker_id/unread-count', authenticate, getUnreadCount);
router.get('/:id/lead-info', authenticate, getNotificationLeadInfo);
router.put('/:id/read', authenticate, markRead);
router.delete('/:id', authenticate, deleteNotification);

export default router;
