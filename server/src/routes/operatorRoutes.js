import { Router } from 'express';
import { authenticateRole, authenticate } from '../middleware/authMiddleware.js';
import {
  addOperatorEvent, editOperatorEvent, getOperatorEvent,
  listOperatorEventsController, removeOperatorEvent, assignEvent,
  operatorDashboard, saveSelfAssignment, uploadOperatorSelfie,
  listOperatorDayAssignments, listEventProgramsController,
  attachEventPrograms, detachEventProgram, listEventBeneficiariesController,
  getKitsController,
} from '../controllers/operatorController.js';

const router = Router();

// Kits screen data (per-NGO counts, today's event, latest handouts).
router.get('/kits', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getKitsController);

// Any authenticated worker can view their own dashboard / assignments.
router.get('/dashboard', authenticate, operatorDashboard);
router.get('/assignments', authenticate, listOperatorDayAssignments);

// Worker saves their own day's assignment + selfie (no admin needed).
router.post('/self-assign', authenticate, saveSelfAssignment);
router.post('/selfie', authenticate, uploadOperatorSelfie);

// Operator event CRUD (admin / ngo / accounts).
router.get('/events', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), listOperatorEventsController);
router.get('/events/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), getOperatorEvent);
router.post('/events', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), addOperatorEvent);
router.put('/events/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), editOperatorEvent);
router.delete('/events/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), removeOperatorEvent);

// Operator → state + event assignment for a day.
router.post('/assign', authenticateRole('super_admin', 'admin', 'ngo'), assignEvent);

// Event programs — attach/list/remove programs under an event. Workers (the
// Beneficiaries app) can read the programs + marked beneficiaries of an event.
router.get('/events/:id/programs', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), listEventProgramsController);
router.post('/events/:id/programs', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), attachEventPrograms);
router.delete('/events/:id/programs/:programId', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), detachEventProgram);
router.get('/events/:id/beneficiaries', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), listEventBeneficiariesController);

export default router;