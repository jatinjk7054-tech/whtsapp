import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware.js';
import { transferConversation, claimConversation } from '../controllers/agentTransferController.js';

const router = Router();

router.use(authenticate);

router.post('/transfer', (req, res, next) => {
  if (req.user.role !== 'super_admin' && req.user.role !== 'tenant_admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}, transferConversation);

router.post('/claim', (req, res, next) => {
  if (req.user.role !== 'agent') {
    return res.status(403).json({ message: 'Agent access required' });
  }
  next();
}, claimConversation);

export default router;
