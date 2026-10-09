import { Router } from 'express';
import multer from 'multer';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  createTemplate,
  listTemplates,
  listNgoOptions,
  listPurposes,
  addPurpose,
  deletePurpose,
  getTemplate,
  getTemplateFile,
  updateTemplate,
  reuploadTemplateFile,
  setTemplatePreview,
  duplicateTemplate,
  setTemplateStatus,
  deleteTemplate,
  snapshotAllTemplates,
  previewCertificate,
  generateCertificate,
  bulkGenerateCertificates,
  listCertificates,
  getCertificate,
} from '../controllers/certificateController.js';

const router = Router();

const TEMPLATE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/octet-stream',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (TEMPLATE_MIMES.has(file.mimetype) || /\.(docx|pptx)$/i.test(file.originalname || '')) return cb(null, true);
    return cb(new Error('Only .docx or .pptx templates are supported.'));
  },
});

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(png|jpeg|jpg|webp|gif)/i.test(file.mimetype || '') || /\.(png|jpe?g|webp|gif)$/i.test(file.originalname || '')) return cb(null, true);
    return cb(new Error('Only PNG, JPG, WEBP or GIF preview images are supported.'));
  },
});

// Wrap multer so its fileFilter errors come back as clean JSON 400s.
const singleTemplate = (req, res, next) => {
  upload.single('template')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    return next();
  });
};

const singlePreview = (req, res, next) => {
  uploadImage.single('preview')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message });
    return next();
  });
};

const MANAGE = authenticateRole('accounts', 'super_admin', 'admin');
const USE = authenticateRole('accounts', 'super_admin', 'admin');

// Template library — accounts can fully manage templates and generate certificates.
router.get('/templates', USE, listTemplates);
router.get('/templates/ngos-options', USE, listNgoOptions);
router.get('/purposes', USE, listPurposes);
router.post('/purposes', MANAGE, addPurpose);
router.delete('/purposes/:id', MANAGE, deletePurpose);
router.get('/templates/:id', USE, getTemplate);
router.get('/templates/:id/file', USE, getTemplateFile);
router.post('/templates', MANAGE, singleTemplate, createTemplate);
router.put('/templates/:id', MANAGE, updateTemplate);
router.post('/templates/:id/file', MANAGE, singleTemplate, reuploadTemplateFile);
router.post('/templates/snapshot-all', MANAGE, snapshotAllTemplates);
router.post('/templates/:id/preview', MANAGE, singlePreview, setTemplatePreview);
router.post('/templates/:id/duplicate', MANAGE, duplicateTemplate);
router.patch('/templates/:id/status', MANAGE, setTemplateStatus);
router.delete('/templates/:id', MANAGE, deleteTemplate);

// Generator + history — available to Accounts too.
router.post('/certificates/preview', USE, previewCertificate);
router.post('/certificates/generate', USE, generateCertificate);
router.post('/certificates/bulk', USE, bulkGenerateCertificates);
router.get('/certificates', USE, listCertificates);
router.get('/certificates/:id', USE, getCertificate);

export default router;