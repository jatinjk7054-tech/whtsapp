import { Router } from 'express';
import { punchIn, punchOut, todayStatus, myHistory, listAll, updateAttendanceRecord, createAttendanceByHR, repairHalfDayRecords, deleteAttendanceRecord, getWorkerMonthlyAttendance, verifySelfie, todayAll, hrSelfiePunch } from '../controllers/attendanceController.js';
import { selfiePunch } from '../controllers/selfiePunchController.js';
import { authenticateRole, authenticate } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/punch-in', authenticate, punchIn);
router.post('/punch-out', authenticate, punchOut);
router.post('/selfie-punch', authenticate, selfiePunch);
router.post('/hr-selfie-punch', authenticateRole('super_admin', 'admin', 'hr'), hrSelfiePunch);
router.get('/today', authenticate, todayStatus);
router.get('/today-all', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), todayAll);
router.get('/history', authenticate, myHistory);
router.get('/all', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), listAll);
router.post('/', authenticateRole('super_admin', 'admin', 'hr'), createAttendanceByHR);
router.post('/repair-half-days', authenticateRole('super_admin', 'admin', 'hr'), repairHalfDayRecords);
router.put('/:id', authenticateRole('super_admin', 'admin', 'hr'), updateAttendanceRecord);
router.put('/:id/verify-selfie', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), verifySelfie);
router.delete('/:id', authenticateRole('super_admin', 'admin', 'hr'), deleteAttendanceRecord);
router.get('/worker/:id', authenticateRole('super_admin', 'admin', 'hr'), getWorkerMonthlyAttendance);

export default router;
