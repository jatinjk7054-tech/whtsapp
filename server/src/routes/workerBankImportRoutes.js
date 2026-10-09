import { Router } from 'express';
import multer from 'multer';
import { inspectBankImport, saveBankDetails } from '../controllers/workerBankImportController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const bankAdmin = authenticateRole('super_admin', 'admin', 'hr', 'accounts');

router.post('/bank-import/inspect', bankAdmin, upload.single('file'), inspectBankImport);
router.post('/bank-import/save', bankAdmin, saveBankDetails);

export default router;
