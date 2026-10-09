import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import { getLeadList, verifyLead, quickVerifyLead, doneLead, rejectLead, goBackLead, undoLeadVerification, undoReceipt, deleteLead, deleteAllPendingLeads, getSuspenseList, createSuspense, addSuspenseNote, assignSuspense, generateReceipt, getReceipt, getReceiptList, getAddressSuggestions, getPendingReceipts, markReceiptAsSent, patchLeadField, getDonorHistory, getDayEndReport, importReceipts, importReceiptNames, getReceiptByMobile, clearReceipts, getReceiptCount, getReceiptNumbers, getSuspenseByNgo, getDonorsList, quickSearchDonors, exportDonors, exportDuplicateDonorAssignments, getDonorDetail, updateDonor, deleteDonor, createDonorAssignment, importDonorAddresses, getExcludedReceipts, fixAndQueueReceipt, deleteQueueReceipt, getImportNgoOptions, getFroWorkersList, updateReceipt, getStationOptions, updateAssignmentStations, deleteAssignment, replaceAssignment, repairDonorSync, backfillReceiptAssignments, getReportTargets, putReportTargets, getReportData, getAgentTeamCollections, getAccessCodeStatus, createAccessCode, verifyAccessCode, changeAccessCode, getNgoCollections } from '../controllers/accountsController.js';
import { restoreWrongAssignments } from '../controllers/ngoAdminController.js';

const router = Router();

const accessCodeRole = authenticateRole('super_admin', 'admin', 'hr', 'accounts');
const donorManageRole = authenticateRole('accounts', 'admin', 'super_admin');

// Donor administration is intentionally scoped to these routes so adding
// admin access here does not broaden access to the rest of Accounts.
router.delete('/donors/:id', donorManageRole, deleteDonor);
router.post('/donors/:id/assignments', donorManageRole, createDonorAssignment);
router.delete('/donors/:id/assignments/:assignmentId', donorManageRole, deleteAssignment);
router.patch('/donors/:id/assignments/:assignmentId/replace', donorManageRole, replaceAssignment);

// Shared access-code used by the HR panel's "Unlock Salary" and accounts
// receipts/reports. Placed before the accounts-only guard so HR/admin can
// manage their own per-user code.
router.get('/access-code/status', accessCodeRole, getAccessCodeStatus);
router.post('/access-code', accessCodeRole, createAccessCode);
router.post('/access-code/verify', accessCodeRole, verifyAccessCode);
router.post('/access-code/change', accessCodeRole, changeAccessCode);

router.use(authenticateRole('accounts', 'super_admin'));

router.get('/leads', getLeadList);
router.get('/leads/address-suggest', getAddressSuggestions);
router.post('/leads/:logId/verify', verifyLead);
router.post('/leads/:logId/quick-verify', quickVerifyLead);
router.post('/leads/:logId/done', doneLead);
router.post('/leads/:logId/reject', rejectLead);
router.post('/leads/:logId/go-back', goBackLead);
router.post('/leads/:logId/undo', undoLeadVerification);
router.delete('/leads', deleteAllPendingLeads);
router.delete('/leads/:logId', deleteLead);
router.patch('/leads/:logId/field', patchLeadField);

router.get('/suspense', getSuspenseList);
router.post('/suspense', createSuspense);
router.post('/suspense/:id/note', addSuspenseNote);
router.post('/suspense/:id/assign', assignSuspense);

router.post('/leads/:logId/receipt', generateReceipt);
router.get('/leads/:logId/receipt', getReceipt);
router.get('/receipts/count', getReceiptCount);
router.get('/receipts/numbers', getReceiptNumbers);
router.get('/receipts/suspense-by-ngo', getSuspenseByNgo);
router.get('/collections', getNgoCollections);
router.get('/receipts', getReceiptList);
router.get('/receipts/pending', getPendingReceipts);
router.get('/receipts/excluded', getExcludedReceipts);
router.post('/receipts/:id/fix-and-queue', fixAndQueueReceipt);
router.delete('/receipts/:id', deleteQueueReceipt);
router.post('/receipts/mark-sent', markReceiptAsSent);
router.get('/receipts/fro-workers', getFroWorkersList);
router.patch('/receipts/:receiptId', updateReceipt);
router.post('/receipts/:receiptId/undo', undoReceipt);
router.post('/receipts/import', importReceipts);
router.post('/receipts/names-import', importReceiptNames);
router.get('/receipts/by-mobile', getReceiptByMobile);
router.get('/ngos', getImportNgoOptions);
router.delete('/receipts', clearReceipts);
router.get('/donors/quick-search', quickSearchDonors);
router.get('/donors', getDonorsList);
router.get('/donors/export', exportDonors);
router.get('/donors/export-duplicates', exportDuplicateDonorAssignments);
router.post('/donors/restore-wrong-assignments', restoreWrongAssignments);
router.post('/donors/backfill-receipt-assignments', donorManageRole, backfillReceiptAssignments);
router.post('/donors/repair-sync', repairDonorSync);
router.post('/donors/address-import', importDonorAddresses);
router.get('/stations-options', getStationOptions);
router.patch('/donors/:id/assignment-station', updateAssignmentStations);
router.delete('/donors/:id/assignments/:assignmentId', deleteAssignment);
router.patch('/donors/:id/assignments/:assignmentId/replace', replaceAssignment);
router.get('/donors/:id', getDonorDetail);
router.patch('/donors/:id', updateDonor);
router.get('/donor/:donorId/history', getDonorHistory);

router.get('/day-end-report', getDayEndReport);

router.get('/report-targets', getReportTargets);
router.put('/report-targets', putReportTargets);
router.get('/report-data', getReportData);
router.get('/report-agent-team', getAgentTeamCollections);

export default router;
