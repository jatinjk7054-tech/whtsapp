import { Router } from 'express';
import {
  getStatus,
  getCeremony,
  getMyBallot,
  castVote,
  listAllDepartments,
  inspectDepartment,
  editDepartment,
  saveDepartmentMembers,
  lookupWorkers,
  listAllSessions,
  startSession,
  openTurn,
  closeTurn,
  completeSession,
  getBoard,
  getSessionAudit,
  getTurnProgress,
} from '../controllers/votingController.js';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

// Every employee votes in every department. The ballot rows carry no voter
// identity, but the endpoints that read them are still gated.
const ANY_AUTH = authenticate;

// Accounts runs the ceremony from `/accounts/awards`. `admin` covers the NGO
// Admin staff who are given the same panel-level rights elsewhere in the app,
// and `super_admin` / `master` keep their global access.
const canManage = authenticateRole('accounts', 'admin', 'super_admin', 'master');

// ── public ────────────────────────────────────────────────────────────────
// Lets the login screen tell people to come back later. Carries no department,
// roster, turn or count data.
router.get('/status', getStatus);

// ── voters ─────────────────────────────────────────────────────────────────
router.get('/ceremony', ANY_AUTH, getCeremony);
router.get('/ballot', ANY_AUTH, getMyBallot);
router.post('/ballot', ANY_AUTH, castVote);

// ── ceremony control ───────────────────────────────────────────────────────
router.get('/departments', canManage, listAllDepartments);
router.get('/departments/:id', canManage, inspectDepartment);
router.put('/departments/:id', canManage, editDepartment);
router.put('/departments/:id/members', canManage, saveDepartmentMembers);
router.get('/workers', canManage, lookupWorkers);

router.get('/sessions', canManage, listAllSessions);
router.post('/sessions', canManage, startSession);
router.get('/sessions/:id/board', canManage, getBoard);
router.get('/sessions/:id/audit', canManage, getSessionAudit);
router.get('/sessions/:id/turns/:deptId/progress', canManage, getTurnProgress);
// One action opens every department's ballot at once; closing a single one is
// only for the odd group with nobody on it.
router.post('/sessions/:id/start', canManage, openTurn);
router.post('/sessions/:id/turns/:deptId/close', canManage, closeTurn);
router.post('/sessions/:id/complete', canManage, completeSession);

export default router;
