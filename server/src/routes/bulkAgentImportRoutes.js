import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware.js';
import multer from 'multer';
import { bulkImportAgents } from '../controllers/bulkAgentImportController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

router.use(authenticate);

router.use((req, res, next) => {
  if (req.user.role !== 'super_admin' && req.user.role !== 'tenant_admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
});

router.post('/bulk-import', upload.single('file'), bulkImportAgents);

export default router;
