import { Router } from 'express';
import {
  addAchievement,
  listAchievements,
  getAchievement,
  removeAchievement,
} from '../controllers/achievementController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHr = authenticateRole('super_admin', 'admin', 'hr');

router.post('/', adminOrHr, addAchievement);
router.get('/', authenticateRole('super_admin', 'admin', 'hr', 'accounts', 'recruiter', 'leads', 'telecaller', 'team_lead'), listAchievements);
router.get('/:id', adminOrHr, getAchievement);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'hr'), removeAchievement);

export default router;
