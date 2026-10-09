import { Router } from 'express';
import {
  apply,
  createLoan,
  myLoans,
  listAll,
  listPending,
  decide,
  getWorkerLoansHandler,
  getWorkerActiveLoans,
  settleMonthly,
  updateLoanRecord,
  deleteLoanRecord,
} from '../controllers/loanController.js';
import { authenticateRole, authenticate } from '../middleware/authMiddleware.js';

const router = Router();

const adminOrHrOrAccounts = authenticateRole('super_admin', 'admin', 'hr', 'accounts');

router.post('/apply', authenticate, apply);
router.post('/create', adminOrHrOrAccounts, createLoan);
router.get('/my', authenticate, myLoans);

router.get('/', adminOrHrOrAccounts, listAll);
router.get('/pending', adminOrHrOrAccounts, listPending);
router.put('/:id/decide', adminOrHrOrAccounts, decide);
router.post('/settle', adminOrHrOrAccounts, settleMonthly);
router.get('/worker/:workerId', authenticateRole('super_admin', 'admin', 'hr', 'accounts'), getWorkerLoansHandler);
router.get('/worker/:workerId/active', adminOrHrOrAccounts, getWorkerActiveLoans);
router.put('/:id', adminOrHrOrAccounts, updateLoanRecord);
router.delete('/:id', adminOrHrOrAccounts, deleteLoanRecord);

export default router;
