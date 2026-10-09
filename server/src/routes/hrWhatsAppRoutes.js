import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  accountStatus,
  history,
  sendLetter,
  sendText,
  serviceWindow,
} from '../controllers/hrWhatsAppController.js';

const router = Router();

// Same role set as letterRoutes.js: HR correspondence is HR's business. The
// existing /api/whatsapp send routes are accounts/super_admin only, so without a
// separate router an HR user gets a 403 on every send.
const hrRoles = authenticateRole('super_admin', 'admin', 'hr');

router.get('/account-status', hrRoles, accountStatus);
router.get('/service-window', hrRoles, serviceWindow);
router.get('/sends', hrRoles, history);
router.post('/text', hrRoles, sendText);
router.post('/letter', hrRoles, sendLetter);

export default router;
