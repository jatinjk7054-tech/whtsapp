import { Router } from 'express';
import { generateQR, listQRCodes, removeQRCode, validateQRAndLocation } from '../controllers/qrController.js';
import { authenticateRole, authenticateWorker } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/generate', authenticateRole('super_admin', 'admin', 'hr'), generateQR);
router.get('/', authenticateRole('super_admin', 'admin', 'hr'), listQRCodes);
router.post('/validate', authenticateWorker, validateQRAndLocation);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'hr'), removeQRCode);

export default router;
