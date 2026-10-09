import { Router } from 'express';
import { parseImage, extractImage } from '../controllers/ocrController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/parse', authenticate, parseImage);
router.post('/extract', authenticate, extractImage);

export default router;

