import { Router } from 'express';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';
import {
  submitRequest,
  myRequests,
  listAll,
  getRequest,
  approveRequest,
  rejectRequest,
  pendingCount,
} from '../controllers/profileUpdateRequestController.js';

const router = Router();

router.use(authenticate);

router.post('/', authenticate, submitRequest);
router.get('/my', authenticate, myRequests);
router.get('/pending-count', authenticateRole('super_admin', 'admin', 'hr'), pendingCount);
router.get('/', authenticateRole('super_admin', 'admin', 'hr'), listAll);
router.get('/:id', authenticateRole('super_admin', 'admin', 'hr'), getRequest);
router.put('/:id/approve', authenticateRole('super_admin', 'admin', 'hr'), approveRequest);
router.put('/:id/reject', authenticateRole('super_admin', 'admin', 'hr'), rejectRequest);

export default router;
