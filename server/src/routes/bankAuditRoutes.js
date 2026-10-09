import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  listSources, addSource, editSource, removeSource,
  listEntries, addEntry, editEntry, removeEntry, getSummary,
  suggestEntries, markEntryVerified, listAvailableEntries, manualMatch,
  listNgoSuspense, linkSuspenseToDonor, markSuspenseUnmatched,
  listFroSuspense, resolveSuspenseEntry,
  runAutoMatch, confirmMatch, clearMatch,
  editSuspenseReceipt, removeSuspenseReceipt,
  searchPendingLeads, manualVerifyEntry, saveManualVerifyDetails, syncReceiptFields,
  checkDonorAssignment,
} from '../controllers/bankAuditController.js';

const router = Router();

// Accounts & Super Admin routes
router.get('/sources', authenticateRole('accounts', 'super_admin'), listSources);
router.post('/sources', authenticateRole('accounts', 'super_admin'), addSource);
router.put('/sources/:id', authenticateRole('accounts', 'super_admin'), editSource);
router.delete('/sources/:id', authenticateRole('accounts', 'super_admin'), removeSource);

router.get('/entries', authenticateRole('accounts', 'super_admin'), listEntries);
router.post('/entries', authenticateRole('accounts', 'super_admin'), addEntry);
router.put('/entries/:id', authenticateRole('accounts', 'super_admin'), editEntry);
router.delete('/entries/:id', authenticateRole('accounts', 'super_admin'), removeEntry);

router.put('/suspense/:id', authenticateRole('accounts', 'super_admin'), editSuspenseReceipt);
router.delete('/suspense/:id', authenticateRole('accounts', 'super_admin'), removeSuspenseReceipt);

router.get('/entries/suggest', authenticateRole('accounts', 'super_admin'), suggestEntries);
router.get('/entries/available', authenticateRole('accounts', 'super_admin'), listAvailableEntries);
router.post('/entries/:id/manual-match', authenticateRole('accounts', 'super_admin'), manualMatch);
router.get('/leads', authenticateRole('accounts', 'super_admin'), searchPendingLeads);
router.put('/entries/:id/verify', authenticateRole('accounts', 'super_admin'), markEntryVerified);

router.post('/auto-match', authenticateRole('accounts', 'super_admin'), runAutoMatch);
router.post('/entries/:id/confirm-match', authenticateRole('accounts', 'super_admin'), confirmMatch);
router.post('/entries/:id/clear-match', authenticateRole('accounts', 'super_admin'), clearMatch);
router.post('/entries/:id/manual-verify', authenticateRole('accounts', 'super_admin'), manualVerifyEntry);
router.put('/entries/:id/manual-verify-details', authenticateRole('accounts', 'super_admin'), saveManualVerifyDetails);
router.get('/check-donor-assignment', authenticateRole('accounts', 'super_admin'), checkDonorAssignment);

router.get('/summary', authenticateRole('accounts', 'super_admin'), getSummary);
router.post('/sync-receipt-fields', authenticateRole('accounts', 'super_admin'), syncReceiptFields);

// NGO Admin routes
router.get('/ngo-suspense', authenticateRole('admin', 'admin', 'super_admin'), listNgoSuspense);
router.put('/ngo-suspense/:id/link-donor', authenticateRole('admin', 'admin', 'super_admin'), linkSuspenseToDonor);
router.put('/ngo-suspense/:id/no-match', authenticateRole('admin', 'admin', 'super_admin'), markSuspenseUnmatched);

// FRO routes
router.get('/fro-suspense', authenticateRole('fro', 'worker', 'super_admin'), listFroSuspense);
router.put('/fro-suspense/:id/resolve', authenticateRole('fro', 'worker', 'super_admin'), resolveSuspenseEntry);

export default router;
