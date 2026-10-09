import { Router } from 'express';
import {
  getWorkerTargets,
  updateTarget,
  getCurrentMonthTargetsList,
  generateAllTargets,
  getMyTarget,
  getWorkerTargetForMonth,
  setAchievement,
  getWorkerAchievements,
  removeAchievement,
  getIncentiveSummary,
  getMonthlySummary,
  bulkSetAchievements,
} from '../controllers/incentiveController.js';
import {
  getAkiConfig,
  putAkiSlabs,
  putIncentiveRules,
  resetAkiConfig,
} from '../controllers/akiSettingsController.js';
import { authenticateRole, authenticateWorker } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHrOrHo = authenticateRole('super_admin', 'admin', 'hr');
// Volunteer detail page is also rendered inside the Accounts panel.
const adminHrAccounts = authenticateRole('super_admin', 'admin', 'hr', 'accounts');
// AKI config can be read by FROs (for the "Aaj Ka Incentive" banner) but only written by admin/accounts.
const akiConfigRead = authenticateRole('super_admin', 'admin', 'hr', 'accounts', 'worker', 'fro');

router.get('/aki-config', akiConfigRead, getAkiConfig);
router.put('/aki-slabs', adminHrAccounts, putAkiSlabs);
router.put('/incentive-rules', adminHrAccounts, putIncentiveRules);
router.post('/aki-config/reset', adminOrHrOrHo, resetAkiConfig);

router.get('/worker/:workerId/targets', adminOrHrOrHo, getWorkerTargets);
router.get('/worker/:workerId/month/:month', adminHrAccounts, getWorkerTargetForMonth);
router.put('/worker/:workerId/month/:month', adminOrHrOrHo, updateTarget);
router.get('/current-month-targets', adminOrHrOrHo, getCurrentMonthTargetsList);
router.post('/generate-all', adminOrHrOrHo, generateAllTargets);
router.get('/my-target', authenticateWorker, getMyTarget);

router.put('/worker/:workerId/achievement/:date', adminHrAccounts, setAchievement);
router.get('/worker/:workerId/achievements/:month', adminHrAccounts, getWorkerAchievements);
router.delete('/achievement/:id', adminOrHrOrHo, removeAchievement);
router.get('/worker/:workerId/incentive-summary/:month', adminHrAccounts, getIncentiveSummary);
router.get('/monthly-summary', adminOrHrOrHo, getMonthlySummary);
router.post('/bulk-achievements', adminOrHrOrHo, bulkSetAchievements);

export default router;
