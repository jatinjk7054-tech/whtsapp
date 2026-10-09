import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import { getNgoAdminTargets, setNgoAdminTarget } from '../controllers/superAdminController.js';

const superAdminAuth = authenticateRole('super_admin');

const router = Router();

router.get('/ngo-admin-targets', superAdminAuth, getNgoAdminTargets);
router.put('/ngo-admin-targets/:workerId', superAdminAuth, setNgoAdminTarget);

export default router;
