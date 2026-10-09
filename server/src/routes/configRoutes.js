import { Router } from 'express';
import { getPublicConfig, getAdminConfig, updateConfig } from '../controllers/configController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/admin', authenticateRole('super_admin', 'admin'), getAdminConfig);
router.put('/admin', authenticateRole('super_admin', 'admin'), updateConfig);
router.get('/', getPublicConfig);

export default router;
