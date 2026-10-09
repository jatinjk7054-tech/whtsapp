import { Router } from 'express';
import {
  getWorkerSalaries,
  addSalary,
  editSalary,
  getWorkersSummary,
  paySalary,
  removeSalary,
  getMySalaryBreakdown,
  getWorkerSalaryWithAllocations,
  getPayrollExport,
  getPresentDaysExport,
  getWorkerAttendance,
  updateWorkerAttendance,
  getPagarExport,
  getAccountsSalaryCompensations,
  saveAccountsSalaryCompensations,
  getSalaryAccessCodeStatus,
  createSalaryAccessCode,
  verifySalaryAccessCode,
  changeSalaryAccessCode,
  getSalaryHold,
  setSalaryHold,
  releaseSalaryHold,
  downloadAttendanceReport,
} from '../controllers/salaryController.js';
import { authenticateRole, authenticate, authenticateSalary } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHrOrHo = authenticateRole('super_admin', 'admin', 'hr', 'accounts');
// Volunteer detail page is also rendered inside the Accounts panel.
const adminHrAccounts = authenticateRole('super_admin', 'admin', 'hr', 'accounts');

router.get('/access-code/status', adminHrAccounts, getSalaryAccessCodeStatus);
router.post('/access-code', adminHrAccounts, createSalaryAccessCode);
router.post('/access-code/verify', adminHrAccounts, verifySalaryAccessCode);
router.post('/access-code/change', adminHrAccounts, changeSalaryAccessCode);
router.get('/workers-summary', adminHrAccounts, getWorkersSummary);
router.get('/payroll', adminOrHrOrHo, getPayrollExport);
router.get('/present-days', authenticateSalary, getPresentDaysExport);
router.get('/attendance', authenticateSalary, getWorkerAttendance);
router.patch('/attendance', authenticateSalary, updateWorkerAttendance);
router.get('/worker/:workerId', adminHrAccounts, getWorkerSalaries);
router.post('/', adminHrAccounts, addSalary);
router.put('/hold', adminHrAccounts, setSalaryHold);
router.put('/compensations', authenticateRole('accounts'), saveAccountsSalaryCompensations);
router.put('/:id', adminHrAccounts, editSalary);
router.put('/:id/pay', adminOrHrOrHo, paySalary);
router.delete('/:id', adminHrAccounts, removeSalary);
router.get('/my-breakdown', authenticate, getMySalaryBreakdown);
router.get('/worker/:workerId/allocations', adminHrAccounts, getWorkerSalaryWithAllocations);
router.get('/worker/:workerId/attendance-report', adminHrAccounts, downloadAttendanceReport);
router.get('/pagar-export', adminHrAccounts, getPagarExport);
router.get('/compensations', authenticateRole('accounts'), getAccountsSalaryCompensations);
router.get('/hold/:workerId', adminHrAccounts, getSalaryHold);
router.put('/hold', adminHrAccounts, setSalaryHold);
router.delete('/hold/:workerId', adminHrAccounts, releaseSalaryHold);

export default router;
