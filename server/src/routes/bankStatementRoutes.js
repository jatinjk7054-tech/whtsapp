import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import { uploadMiddleware, previewStatement, importStatement } from '../controllers/bankStatementController.js';

const router = Router();

router.post('/preview', authenticateRole('accounts', 'super_admin'), uploadMiddleware, previewStatement);
router.post('/import', authenticateRole('accounts', 'super_admin'), uploadMiddleware, importStatement);

export default router;
