import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  createNewBenefit, listAllBenefits, getBenefit,
  updateBenefitController, setBenefitEligibility, getBenefitEligibility,
} from '../controllers/benefitController.js';

const router = Router();

router.get('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), listAllBenefits);
router.post('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), createNewBenefit);
router.get('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getBenefit);
router.patch('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), updateBenefitController);
router.post('/:id/eligibility', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), setBenefitEligibility);
router.get('/:id/eligibility', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getBenefitEligibility);

export default router;
