import { Router } from 'express';
import {
  apply,
  myLeaves,
  listAll,
  listPending,
  updateStatus,
} from '../controllers/leaveController.js';
import { authenticateRole, authenticate } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHrOrHo = authenticateRole('super_admin', 'admin', 'hr');

router.post('/apply', authenticate, apply);
router.get('/my', authenticate, myLeaves);
router.get('/', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), listAll);
router.get('/pending', adminOrHrOrHo, listPending);
router.put('/:id/status', adminOrHrOrHo, updateStatus);

export default router;
