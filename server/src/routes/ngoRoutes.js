import { Router } from 'express';
import { addNgo, listNgos, getNgo, editNgo, removeNgo, toggleNgo, getNgoSummary, listNgoOptions, getNgoMemberCounts } from '../controllers/ngoController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHrOrHo = authenticateRole('super_admin', 'admin', 'hr');
// Read access for the Volunteers tab in the Accounts panel.
const adminHrAccounts = authenticateRole('super_admin', 'admin', 'hr', 'accounts');
// Read access for the Beneficiaries app (operator works for a particular NGO).
const appWorker = authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker');

router.get('/', adminHrAccounts, listNgos);
router.get('/summary', adminHrAccounts, getNgoSummary);
// Lightweight options for the operator app NGO dropdown. Must be declared
// before '/:id' so "options" is not parsed as an id.
router.get('/options', appWorker, listNgoOptions);
// Total members per NGO — NGO cards on the Beneficiaries app home section.
router.get('/member-counts', appWorker, getNgoMemberCounts);
router.post('/', adminOrHrOrHo, addNgo);
router.get('/:id', adminOrHrOrHo, getNgo);
router.put('/:id', adminOrHrOrHo, editNgo);
router.delete('/:id', adminOrHrOrHo, removeNgo);
router.put('/:id/toggle', adminOrHrOrHo, toggleNgo);

export default router;
