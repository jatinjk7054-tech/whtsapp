import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  createHandler,
  aiDraftHandler,
  updateHandler,
  activeHandler,
  historyHandler,
  cancelHandler,
  refreshHandler,
  detailHandler,
  leaderboardHandler,
  claimsHandler,
  verifyClaimHandler,
  congratsHandler,
  celebrateHandler,
  archiveHandler,
  deleteHandler,
} from '../controllers/specialIncentiveController.js';

const router = Router();

const sirLevel = authenticateRole('super_admin', 'admin', 'accounts');
// Anyone who should see the live popup: FROs, Accounts, HR, Admin, Super Admin.
const popupLevel = authenticateRole('super_admin', 'admin', 'accounts', 'hr', 'worker', 'fro');
// Accounts-level role gate for prize verification/claim.
const claimLevel = authenticateRole('super_admin', 'admin', 'accounts', 'hr');

router.post('/', sirLevel, createHandler);
router.post('/ai-draft', sirLevel, aiDraftHandler);
router.put('/:id', sirLevel, updateHandler);
router.post('/:id/congrats', sirLevel, congratsHandler);
router.get('/active', popupLevel, activeHandler);
router.get('/', sirLevel, historyHandler);
router.get('/claims', claimLevel, claimsHandler);
router.get('/:id/leaderboard', popupLevel, leaderboardHandler);
router.get('/:id', popupLevel, detailHandler);
router.post('/:id/refresh', popupLevel, refreshHandler);
router.post('/:id/cancel', sirLevel, cancelHandler);
router.post('/:id/claim', claimLevel, verifyClaimHandler);
router.post('/:id/celebrate', sirLevel, celebrateHandler);
router.post('/:id/archive', sirLevel, archiveHandler);
router.delete('/:id', sirLevel, deleteHandler);

export default router;
