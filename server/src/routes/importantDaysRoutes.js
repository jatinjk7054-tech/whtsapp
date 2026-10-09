import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import { listImportantDays } from '../controllers/eventHeadController.js';

// GET /api/important-days?year=2026&month=10&scope=all
// Mounted at /api/important-days in src/index.js. Shares the calendar auth with
// the other Calendar endpoints so the grid needs just one login session.
const router = Router();
router.get(
  '/',
  authenticateRole('super_admin', 'admin', 'hr', 'event_head', 'event_manager', 'Event Manager', 'Event Head'),
  listImportantDays,
);

export default router;