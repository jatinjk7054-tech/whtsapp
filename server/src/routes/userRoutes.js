import { Router } from 'express';
import { addUser, listUsers, getUser, editUser, getUserNgoAccessHandler, setUserNgoAccessHandler } from '../controllers/userController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/', authenticateRole('super_admin', 'admin', 'hr'), addUser);
router.get('/', authenticateRole('super_admin', 'admin', 'hr'), listUsers);
router.get('/:id', authenticateRole('super_admin', 'admin', 'hr'), getUser);
router.put('/:id', authenticateRole('super_admin', 'admin'), editUser);
router.get('/:id/ngo-access', authenticateRole('super_admin', 'admin'), getUserNgoAccessHandler);
router.put('/:id/ngo-access', authenticateRole('super_admin', 'admin'), setUserNgoAccessHandler);

export default router;
