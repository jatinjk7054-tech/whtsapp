import { Router } from 'express';
import { addHR, listHRs, getHR, editHR } from '../controllers/hrController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/', authenticateRole('super_admin', 'admin'), addHR);
router.get('/', authenticateRole('super_admin', 'admin', 'hr'), listHRs);
router.get('/:id', authenticateRole('super_admin', 'admin', 'hr'), getHR);
router.put('/:id', authenticateRole('super_admin', 'admin'), editHR);

export default router;
