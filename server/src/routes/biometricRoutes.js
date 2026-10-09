import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  enrollFingerprint, verifyFingerprint, identifyFingerprint, getBiometricDetails, revokeFingerprint, listFingerprintTemplates,
} from '../controllers/biometricController.js';

const router = Router();

router.post('/enroll', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'worker'), enrollFingerprint);
router.post('/verify', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), verifyFingerprint);
router.post('/identify', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), identifyFingerprint);
router.get('/templates', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), listFingerprintTemplates);
router.get('/beneficiary/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getBiometricDetails);
router.post('/:id/revoke', authenticateRole('super_admin', 'admin', 'ngo'), revokeFingerprint);

export default router;
