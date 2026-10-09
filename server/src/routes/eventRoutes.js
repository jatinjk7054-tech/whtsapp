import { Router } from 'express';
import {
  addEvent,
  listEvents,
  getEvent,
  editEvent,
  removeEvent,
} from '../controllers/eventController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHr = authenticateRole('super_admin', 'admin', 'hr');

router.post('/', adminOrHr, addEvent);
router.get('/', authenticateRole('super_admin', 'admin', 'hr', 'accounts', 'recruiter', 'leads', 'telecaller', 'team_lead'), listEvents);
router.get('/:id', adminOrHr, getEvent);
router.put('/:id', adminOrHr, editEvent);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'hr'), removeEvent);

export default router;
