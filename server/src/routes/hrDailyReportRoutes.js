import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  attendanceSummary,
  getMyReport,
  getReports,
  saveReport,
} from '../controllers/hrDailyReportController.js';

const router = Router();

// Same role set as hrWhatsAppRoutes.js: the daily HR report is HR's business and
// carries staff absence data, so it is not readable by accounts/recruiter tokens.
const hrRoles = authenticateRole('super_admin', 'admin', 'hr', 'recruiter');

router.get('/attendance-summary', hrRoles, attendanceSummary);
router.get('/mine', hrRoles, getMyReport);
router.get('/', hrRoles, getReports);
router.post('/', hrRoles, saveReport);

export default router;
