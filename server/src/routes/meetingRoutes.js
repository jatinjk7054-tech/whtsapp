import { Router } from 'express';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';
import { getMeetingStatus, startMeeting, endMeeting } from '../controllers/meetingController.js';

const router = Router();

// GET is available to every logged-in role so all panels can watch for it.
// no-store matters here: a cached response would pin clients to an OLD
// meeting's started_at, so some users would see a stale elapsed time.
router.get('/', authenticate, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, getMeetingStatus);
// Start/End are NGO-admin / super-admin actions (global meeting).
router.post('/start', authenticateRole('admin', 'super_admin'), startMeeting);
router.post('/end', authenticateRole('admin', 'super_admin'), endMeeting);

export default router;