import { Router } from 'express';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';
import {
  raiseTicket,
  myTickets,
  listPending,
  listHrVerified,
  listAllTickets,
  getTicket,
  verifyTicket,
  approveTicket,
  rejectTicket,
  pendingCount,
} from '../controllers/attendanceCorrectionController.js';

const router = Router();

router.post('/', authenticate, raiseTicket);
router.get('/my', authenticate, myTickets);
router.get('/pending', authenticateRole('super_admin', 'admin', 'hr'), listPending);
router.get('/hr-verified', authenticateRole('super_admin'), listHrVerified);
router.get('/all', authenticateRole('super_admin', 'admin', 'hr'), listAllTickets);
router.get('/pending-count', authenticateRole('super_admin', 'admin', 'hr'), pendingCount);
router.get('/:id', authenticateRole('super_admin', 'admin', 'hr'), getTicket);
router.put('/:id/verify', authenticateRole('super_admin', 'admin', 'hr'), verifyTicket);
router.put('/:id/approve', authenticateRole('super_admin'), approveTicket);
router.put('/:id/reject', authenticateRole('super_admin', 'admin', 'hr'), rejectTicket);

export default router;
