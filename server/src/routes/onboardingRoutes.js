import { Router } from 'express';
import {
  submitOnboarding,
  checkOnboardingStatus,
  uploadPhoto,
  uploadDocument,
  getPolicies,
  getProfileForPrint,
  adminGetPolicies,
  adminAddPolicy,
  adminEditPolicy,
  adminRemovePolicy,
  adminUploadPhoto,
  uploadSignature,
  uploadWorkerSignature,
  commitWorkerSignature,
  getWorkerSignature,
} from '../controllers/onboardingController.js';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

// Worker-facing routes (authenticated via worker token)
router.post('/submit', authenticate, submitOnboarding);
router.get('/status', authenticate, checkOnboardingStatus);
router.post('/upload-photo', authenticate, uploadPhoto);
router.post('/upload-document', authenticate, uploadDocument);
router.get('/policies', authenticate, getPolicies);
router.get('/print-profile', authenticate, getProfileForPrint);

// Admin routes for policies management
const adminAuth = authenticateRole('super_admin', 'admin', 'hr');
router.get('/admin/policies', adminAuth, adminGetPolicies);
router.post('/admin/policies', adminAuth, adminAddPolicy);
router.put('/admin/policies/:id', adminAuth, adminEditPolicy);
router.delete('/admin/policies/:id', adminAuth, adminRemovePolicy);

// Worker: signature is two-phase.
//   POST /upload-signature    -> stores the image (draft, or signed with commit=true)
//   POST /signature/commit    -> locks a stored draft on final submit
//   GET  /signature           -> current signature + active policies
router.post('/upload-signature', authenticate, uploadWorkerSignature);
router.post('/signature/commit', authenticate, commitWorkerSignature);
router.get('/signature', authenticate, getWorkerSignature);

// Admin: upload photo for any worker (also used by the Accounts panel volunteer detail)
router.post('/admin/upload-photo/:workerId', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), adminUploadPhoto);

// Admin: upload digital signature for a worker
router.post('/admin/upload-signature/:workerId', adminAuth, uploadSignature);

export default router;
