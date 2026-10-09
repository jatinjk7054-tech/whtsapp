import { Router } from 'express';
import { whatsappCrmLogin, whatsappCrmRegister, whatsappCrmMe, whatsappCrmLogout } from '../controllers/whatsappCrmAuthController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/auth/login', whatsappCrmLogin);
router.post('/auth/register', whatsappCrmRegister);
router.get('/auth/me', authenticate, whatsappCrmMe);
router.post('/auth/logout', whatsappCrmLogout);

export default router;
