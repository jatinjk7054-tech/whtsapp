import { Router } from 'express';
import { adminLogin, unifiedLogin, salaryLogin, impersonateFRO, getFroWorkersForImpersonation, getFroWorkAsStations, releaseWorkAs, changePassword, logout } from '../controllers/authController.js';
import { getMyCrmAgentContext } from '../controllers/crmAgentsController.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/admin/login', adminLogin);
router.post('/worker/login', unifiedLogin);
router.post('/login', unifiedLogin);
router.post('/salary-login', salaryLogin);
router.post('/impersonate', authenticate, impersonateFRO);
router.get('/fro-workers', authenticate, getFroWorkersForImpersonation);
router.get('/fro-workers/:workerId/stations', authenticate, getFroWorkAsStations);
router.post('/work-as/release', authenticate, releaseWorkAs);
router.post('/change-password', authenticate, changePassword);
router.post('/logout', authenticate, logout);
// Self-service, so it belongs with the session endpoints rather than behind the
// NGO-admin gate: this is the call an FRO panel makes to find out whether it should
// offer the account switcher (admin mid-cover) or not (agent, bound to one FRO).
router.get('/agent-context', authenticate, getMyCrmAgentContext);

export default router;
