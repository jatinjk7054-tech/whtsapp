import { Router } from 'express';
import multer from 'multer';
import { inspectImport, uploadImport, listImportBatches, getImportBatch, exportBatch, downloadSample, downloadTestSheet, uploadOldDataImport, copyDonorsToNgos, uploadChunk } from '../controllers/dataImportController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/inspect', authenticateRole('super_admin'), upload.single('file'), inspectImport);
router.post('/upload', authenticateRole('super_admin'), upload.single('file'), uploadImport);
router.get('/batches', authenticateRole('super_admin'), listImportBatches);
router.get('/batch/:id', authenticateRole('super_admin'), getImportBatch);
router.get('/batch/:id/export', authenticateRole('super_admin'), exportBatch);
router.get('/sample', authenticateRole('super_admin'), downloadSample);
router.get('/test-sheet', authenticateRole('super_admin'), downloadTestSheet);
router.post('/upload-old', authenticateRole('super_admin'), upload.single('file'), uploadOldDataImport);
router.post('/copy-to-ngos', authenticateRole('super_admin'), copyDonorsToNgos);
router.post('/upload-chunk', authenticateRole('super_admin'), uploadChunk);

export default router;
