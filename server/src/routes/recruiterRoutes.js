import { Router } from 'express';
import { listRecruiters, getRecruiterStats, getRecruiterOverview } from '../controllers/recruiterController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

// These endpoints compare recruiters against each other: /overview returns every
// recruiter's stats plus company-wide totals, and /:id/stats accepts any recruiter
// id. A recruiter has no business reading a colleague's numbers, so the role is
// excluded and only the HR panel (which uses all three) can reach them.
const hrOnly = authenticateRole('super_admin', 'admin', 'hr');

router.get('/overview', hrOnly, getRecruiterOverview);
router.get('/', hrOnly, listRecruiters);
router.get('/:id/stats', hrOnly, getRecruiterStats);

export default router;
