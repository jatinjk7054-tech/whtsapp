import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import { generateCode, listCodes, listAllCodesDebug } from '../controllers/codeController.js';

const router = Router();

// FROs generate codes from their panel; admins/super admins generate too.
router.post('/generate', authenticateRole('fro', 'admin', 'super_admin'), generateCode);
// All authenticated users (Flutter workers need to see codes).
router.get('/', authenticateRole('fro', 'admin', 'super_admin'), listCodes);
// Debug: admin/super_admin/master - list ALL codes across all NGOs
router.get('/all', authenticateRole('admin', 'super_admin', 'master'), listAllCodesDebug);

export default router;
