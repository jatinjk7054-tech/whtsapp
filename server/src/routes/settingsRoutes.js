import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settingsController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateRole('super_admin', 'admin', 'hr'), getSettings);
router.put('/', authenticateRole('super_admin', 'admin', 'hr'), updateSettings);

export default router;
