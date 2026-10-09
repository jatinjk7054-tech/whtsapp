import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  issueBenefit, getDistribution, listAllDistributions,
  reverseDistributionController, getBeneficiaryHistory,
} from '../controllers/distributionController.js';

const router = Router();

router.post('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), issueBenefit);
router.get('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head'), listAllDistributions);
router.get('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head'), getDistribution);
router.post('/:id/reverse', authenticateRole('super_admin', 'admin', 'ngo'), reverseDistributionController);
router.get('/beneficiary/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getBeneficiaryHistory);

export default router;
