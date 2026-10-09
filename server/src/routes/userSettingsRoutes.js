import { Router } from 'express';
import { getUserSettings, updateUserSettings } from '../controllers/userSettingsController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateRole('accounts', 'super_admin'), getUserSettings);
router.put('/', authenticateRole('accounts', 'super_admin'), updateUserSettings);

export default router;
