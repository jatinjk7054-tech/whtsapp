import { Router } from 'express';
import multer from 'multer';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  getCrmAgents,
  getCrmAgentFroOptions,
  createCrmAgent,
  bulkCreateCrmAgents,
  updateCrmAgentStatus,
  updateCrmAgentAssignment,
  resetCrmAgentPassword,
  forceLogoutCrmAgent,
  deleteCrmAgent,
} from '../controllers/crmAgentsController.js';
import {
  listNgoSuspense, linkSuspenseToDonor, markSuspenseUnmatched, searchDonorsForSuspense,
} from '../controllers/bankAuditController.js';
import {
  getFullDonorDetail,
  getDonorReceipts,
  getDonorFollowups,
  getDonorTransactions,
} from '../controllers/ngoAdminController.js';
import {
  getFroWorkers,
  getAccessibleNgos,
  getAssignments,
  setTarget,
  getTargets,
  transferDonorCredit,
  getDashboard,
  getDailyTarget,
  getFroWiseCollection,
  setAchievedTarget,
  setIncentive,
  getAccountsPending,
  verifyLeadDone,
  getStations,
  saveStationAssignment,
  removeStationAssignment,
  removeStationByName,
  createStationHandler,
  reassignStationFro,
  updateStationNgos,
  getStationStats,
  getDonorsByStation,
  getDonorsByFro,
  getNewData,
  distributeNewData,
  cleanupNewData,
  resetFreshData,
  getDataOverview,
  getAlerts,
  acknowledgeAlert,
  getRejectedLeads,
  acknowledgeRejectedLead,
  getDataRequests,
  resolveDataRequest,
  transferStationData,
  returnTransferEarly,
  getTransferHistory,
  getTransferDonors,
  getIncentives,
  getVerificationFroWise,
  getFroPerformance,
  getFroDailyStats,
  masterSearch,
  getCallAnalytics,
  getFroSummary,
  seedStations,
  cleanupOrphanedStations,
  bulkRenameStations,
  getStationRenameLog,
  uploadOldData,
  uploadOldDataForStation,
  // NEW Dashboard APIs
  getTLDashboard,
  getDonationFunnel,
  getHourlyPerformance,
  getFollowups,
  reassignFollowup,
  updateFollowupDate,
  pauseFro,
  resumeFro,
  notifyFroHandler,
  getTopPerformers,
  getBottomPerformers,
  getAssignedData,
  restoreWrongAssignments,
  getFroHourlyPerformance,
  getStationWiseCollection,
  getTeamWiseCollection,
  ensureStandardNgos,
  getAllNgosForTabs,
  getNonConnectedFresh,
  deleteNonConnectedFresh,
  deleteStationDonors,
} from '../controllers/ngoAdminController.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

router.get('/rejected-leads', authenticateRole('admin', 'super_admin'), getRejectedLeads);
router.put('/rejected-leads/:id/acknowledge', authenticateRole('admin', 'super_admin'), acknowledgeRejectedLead);

// Accounts reports need stations/targets/ngos — allow accounts role for these read-only endpoints
router.get('/stations', authenticateRole('admin', 'super_admin', 'accounts'), getStations);
router.get('/targets', authenticateRole('admin', 'super_admin', 'accounts', 'hr'), getTargets);

// Setting an FRO's monthly collection target is a people decision, not an
// accounts one: HR sets it from the roster and Accounts reconciles against it.
// This sits ABOVE the router.use below on purpose — anything registered after
// that line inherits the admin-only guard, which is why a route declared down
// there could not simply be widened in place.
router.post('/targets', authenticateRole('admin', 'super_admin', 'accounts', 'hr'), setTarget);

router.use(authenticateRole('admin', 'super_admin'));
router.get('/ngos', authenticateRole('admin', 'super_admin', 'accounts'), getAccessibleNgos);
router.post('/ngos/ensure', authenticateRole('admin', 'super_admin'), ensureStandardNgos);
router.get('/ngos/all', authenticateRole('admin', 'super_admin', 'accounts'), getAllNgosForTabs);

// Accounts panel handles New Data distribution + Old Data viewing — allow accounts role
router.get('/donors-by-station', authenticateRole('admin', 'super_admin', 'accounts'), getDonorsByStation);
router.get('/new-data', authenticateRole('admin', 'super_admin', 'accounts'), getNewData);
router.post('/new-data/distribute', authenticateRole('admin', 'super_admin', 'accounts'), distributeNewData);
router.post('/new-data/cleanup', authenticateRole('admin', 'super_admin', 'accounts'), cleanupNewData);
router.post('/new-data/reset', authenticateRole('admin', 'super_admin', 'accounts'), resetFreshData);

// Non-connected fresh-data pull (NGO admin only)
router.get('/non-connected-fresh', authenticateRole('admin', 'super_admin'), getNonConnectedFresh);
router.post('/non-connected-fresh/delete', authenticateRole('admin', 'super_admin'), deleteNonConnectedFresh);

// Removing a wrongly-duplicated donor from a station (NGO admin only).
//
// Deliberately NOT widened to 'accounts' the way the donors-by-station read above
// (line 134) is. Accounts may look at a station's donors; clearing one is a
// destructive action on an FRO's work list, so it stays admin/super_admin.
router.post('/station-donors/delete', authenticateRole('admin', 'super_admin'), deleteStationDonors);

// Per-day FRO stats (calls / talk / break / skips) — also used by HR for warning letters on a selected FRO
router.get('/fro-daily-stats', authenticateRole('admin', 'super_admin', 'hr'), getFroDailyStats);

router.use(authenticateRole('admin', 'super_admin'));

router.get('/dashboard', getDashboard);
router.get('/dashboard/daily-target', getDailyTarget);
router.get('/dashboard/station-stats', getStationStats);

// NEW TL Dashboard APIs
router.get('/tl-dashboard', getTLDashboard);
router.get('/dashboard/donation-funnel', getDonationFunnel);
router.get('/dashboard/hourly-performance', getHourlyPerformance);
router.post('/fro/:id/pause', authenticateRole('admin', 'super_admin'), pauseFro);
router.post('/notify-fro', authenticateRole('admin', 'super_admin'), notifyFroHandler);
router.post('/fro/:id/resume', authenticateRole('admin', 'super_admin'), resumeFro);
router.get('/dashboard/top-performers', getTopPerformers);
router.get('/dashboard/bottom-performers', getBottomPerformers);

// Follow-up Management
router.get('/followups', getFollowups);
router.put('/followups/:assignmentId/reassign', reassignFollowup);
router.put('/followups/:assignmentId/date', updateFollowupDate);

// Assigned Data
router.get('/assigned-data', getAssignedData);

// The standalone Donors list page was removed from the NGO-admin panel, so the
// /donors list, its per-donor credit log and the mobile-number detail endpoint
// went with it. donors-by-fro, donors-by-station and the /donor-crm/donors/*
// family stay: StationManagement, the Dashboard and the shared DonorDetailModal
// all still call those.
router.put('/credit-logs/:logId/transfer', transferDonorCredit);
router.get('/donors-by-fro', getDonorsByFro);
router.get('/fro-workers', getFroWorkers);
router.get('/assignments', getAssignments);
router.get('/collections/fro-wise', getFroWiseCollection);
router.get('/fro-performance', getFroPerformance);
router.get('/fro/:id/summary', getFroSummary);
router.post('/achieved-target', setAchievedTarget);
router.get('/incentives', getIncentives);
router.post('/incentive', setIncentive);
router.get('/verification', getVerificationFroWise);
router.get('/accounts/pending', getAccountsPending);
router.post('/accounts/:logId/verify', verifyLeadDone);

router.post('/stations', createStationHandler);
router.post('/station-assignments', saveStationAssignment);
router.delete('/station-assignments/:id', removeStationAssignment);
router.put('/station-assignments/:id/reassign', reassignStationFro);
router.put('/stations/:station/update-ngos', updateStationNgos);
router.delete('/stations/:station', removeStationByName);
router.post('/stations/:station/transfer-data', transferStationData);
router.get('/transfers', getTransferHistory);
router.get('/transfers/:id/donors', getTransferDonors);
router.post('/transfers/:id/return-early', returnTransferEarly);

router.get('/data-overview', getDataOverview);

router.get('/alerts', getAlerts);
router.put('/alerts/:id/acknowledge', acknowledgeAlert);

router.get('/database-requests', getDataRequests);
router.put('/database-requests/:id/resolve', resolveDataRequest);

router.get('/suspense', listNgoSuspense);
router.put('/suspense/:id/link-donor', linkSuspenseToDonor);
router.put('/suspense/:id/no-match', markSuspenseUnmatched);
router.get('/suspense/search-donors', searchDonorsForSuspense);

// The Donor CRM page was removed from the NGO-admin panel. Its lead workflows
// (import/upload, assign, transfer, history, duplicates) and the follow-up
// create endpoint had that page as their only caller, so they go with it.
//
// The donor READ endpoints stay deliberately: DonorDetailModal is shared, not
// part of Donor CRM. Master search and SearchResults still open it, and it calls
// all four of these.
router.get('/donor-crm/donors/:id', getFullDonorDetail);
router.get('/donor-crm/donors/:id/receipts', getDonorReceipts);
router.get('/donor-crm/donors/:id/followups', getDonorFollowups);
router.get('/donor-crm/donors/:id/transactions', getDonorTransactions);

router.get('/master-search', masterSearch);
router.get('/call-analytics', getCallAnalytics);
router.get('/fro-hourly-performance', getFroHourlyPerformance);
router.get('/station-collection', getStationWiseCollection);
// No extra authenticateRole here: the router.use(authenticateRole('admin',
// 'super_admin')) gates above already, and this endpoint is deliberately gated the
// same as its sibling /station-collection so the two cannot disagree on who may read
// the same receipts.
router.get('/team-collection', getTeamWiseCollection);

router.post('/stations/seed', seedStations);
router.post('/stations/cleanup', cleanupOrphanedStations);
router.post('/stations/bulk-rename', bulkRenameStations);
router.get('/stations/rename-log', getStationRenameLog);
router.post('/stations/:station/upload-old-data', upload.single('file'), uploadOldDataForStation);
router.post('/old-data/upload', upload.single('file'), uploadOldData);

router.post('/restore-wrong-assignments', restoreWrongAssignments);

// ─── CRM login agents ("Agent N") ───────────────────────────────────────────
//
// Guarded to admin / super_admin, narrower than the rest of this router on
// purpose: these endpoints hand out a credential that reaches an FRO's entire
// account. It sits below the two router.use(...) gates above, so it inherits the
// admin+super_admin check and then adds nothing.

router.get('/agents', getCrmAgents);
router.get('/agents/fro-options', getCrmAgentFroOptions);
router.post('/agents', createCrmAgent);
router.post('/agents/bulk', bulkCreateCrmAgents);
router.patch('/agents/:id/status', updateCrmAgentStatus);
router.patch('/agents/:id/assignment', updateCrmAgentAssignment);
router.post('/agents/:id/reset-password', resetCrmAgentPassword);
router.post('/agents/:id/force-logout', forceLogoutCrmAgent);
router.delete('/agents/:id', deleteCrmAgent);

export default router;
