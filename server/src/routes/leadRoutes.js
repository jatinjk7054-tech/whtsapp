import { Router } from 'express';
import { addLead, listLeads, getLead, editLead, removeLead, transferLeadOwner, dashboard } from '../controllers/leadController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

const hrOrAbove = authenticateRole('super_admin', 'admin', 'hr', 'recruiter');

const leadReadWrite = authenticateRole('super_admin', 'admin', 'hr', 'recruiter', 'telecaller');

router.get('/dashboard', hrOrAbove, dashboard);
router.post('/', hrOrAbove, addLead);
router.get('/', leadReadWrite, listLeads);
router.get('/:id', leadReadWrite, getLead);
router.put('/:id', leadReadWrite, editLead);
router.put('/:id/transfer', hrOrAbove, transferLeadOwner);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'recruiter'), removeLead);

export default router;
