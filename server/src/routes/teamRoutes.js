import { Router } from 'express';
import { getTeams, putTeams } from '../controllers/teamController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), getTeams);
router.put('/', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), putTeams);

export default router;