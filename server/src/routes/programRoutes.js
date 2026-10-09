import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  createNewProgram, getProgram, updateProgramController,
  listAllPrograms, assignBeneficiariesToProgram,
  checkInBeneficiaryToProgram, getProgramLiveDashboard, scanBeneficiaryQR,
} from '../controllers/programController.js';
import {
  createVolunteer, getVolunteerById, updateVolunteer, listVolunteers,
  assignToProgram, getProgramVolunteers, checkInVolunteer,
} from '../models/volunteerModel.js';

const router = Router();

// Programs
router.get('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), listAllPrograms);
router.post('/', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), createNewProgram);
router.get('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), getProgram);
router.patch('/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), updateProgramController);
router.get('/:id/dashboard', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head'), getProgramLiveDashboard);

// Program Beneficiaries
router.post('/:id/beneficiaries', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), assignBeneficiariesToProgram);
router.post('/:id/check-in', authenticateRole('super_admin', 'admin', 'ngo', 'event_head', 'worker'), checkInBeneficiaryToProgram);
router.post('/:id/scan', authenticateRole('super_admin', 'admin', 'ngo', 'event_head', 'worker'), scanBeneficiaryQR);

// Program Volunteers
router.post('/:id/volunteers', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const { volunteer_id, role } = req.body;
    const result = await assignToProgram(req.params.id, volunteer_id, role);
    return res.status(201).json(result);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});
router.get('/:id/volunteers', authenticateRole('super_admin', 'admin', 'ngo', 'accounts', 'event_head', 'worker'), async (req, res) => {
  try {
    const volunteers = await getProgramVolunteers(req.params.id);
    return res.json(volunteers);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});
router.post('/:id/volunteers/check-in', authenticateRole('super_admin', 'admin', 'ngo', 'event_head', 'worker'), async (req, res) => {
  try {
    const { volunteer_id } = req.body;
    const result = await checkInVolunteer(req.params.id, volunteer_id);
    return res.json(result);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

// Volunteers CRUD
router.get('/volunteers/all', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const { page, pageSize, search, status, ngo_id } = req.query;
    const result = await listVolunteers({ page: parseInt(page) || 1, pageSize: parseInt(pageSize) || 25, search, status, ngo_id });
    return res.json(result);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});
router.post('/volunteers/create', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const volunteer = await createVolunteer({ ...req.body, created_by: req.user?.name || 'system' });
    return res.status(201).json(volunteer);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});
router.get('/volunteers/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const volunteer = await getVolunteerById(req.params.id);
    if (!volunteer) return res.status(404).json({ message: 'Volunteer not found' });
    return res.json(volunteer);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});
router.patch('/volunteers/:id', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  try {
    const volunteer = await updateVolunteer(req.params.id, { ...req.body, updated_by: req.user?.name || 'system' });
    return res.json(volunteer);
  } catch (e) { return res.status(500).json({ message: e.message }); }
});

export default router;
