import { Router } from 'express';
import db from '../config/db.js';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';
import {
  listFroSuspense, resolveSuspenseEntry, searchFroDispositions,
} from '../controllers/bankAuditController.js';
import {
  getDashboard,
  getMyAllotmentSummary,
  getMyPerformance,
  getMyCollections,
  getMyTeamsCollection,
  getMyDonors,
  getTransferredLeads,
  updateDonorStatus,
  updateDonorType,
  getDonorLogs,
  createDonorLogHandler,
  getMyTarget,
  scheduleContact,
  uploadPaymentScreenshot,
  getMyStations,
  getFroScheduled,
  getFroCallbacks,
  getFroPromises,
  getFroOverdue,
  getMyHistory,
  requestData,
  getMyDataRequests,
  getFollowUps,
  getLeadStats,
  getMonthlyDonors,
  getDonorHistory,
  getFullDonorHistory,
  getDonorDonations,
  getDonorReceipts,
  searchDonors,
  getMyDisposedLeads,
  updateLiveStatus,
  getLiveStatuses,
  getPresentToday,
  getMyProgress,
  saveMyProgress,
  getReactivatedDonors,
  getSuspenseReceipts,
  claimSuspenseReceipt,
  searchSuspenseDonors,
  getMyLiveStatus,
  resumeOwnPause,
  applyFroTimeEvent,
  // resumeOwnIdle removed: see the note at the end of the /status routes.
  logoutAllFros,
} from '../controllers/froController.js';
import {
  getMyIdleReport,
  getMyIdleSessions,
  getIdleReport,
  getIdleSessions,
} from '../controllers/froReportController.js';

const router = Router();

router.use(authenticate);

router.get('/status', authenticateRole('super_admin', 'admin'), getLiveStatuses);
// Attendance-punched roster for today. Registered next to /status; the path is
// two segments so it cannot be shadowed by any single-segment /:id route.
router.get('/status/present', authenticateRole('super_admin', 'admin'), getPresentToday);
// idle reset route removed as part of idle time removal
router.post('/status/logout-all', authenticateRole('admin', 'super_admin'), logoutAllFros);
router.get('/status/me', getMyLiveStatus);
// The single event ingress for the server-authoritative time machine. Discrete
// client events (page hidden/visible, meeting start/end, pause, network lost,
// sleep) map to state transitions in the open interval ledger.
router.post('/status/time-event', applyFroTimeEvent);

// Historical idle reporting. Self routes (no role guard) resolve the caller's own
// worker id; the admin routes below them are role-guarded and NGO-scoped in the
// controller. All figures come from fro_time_sessions via froTimeReport.
router.get('/reports/idle/me', getMyIdleReport);
router.get('/reports/idle/me/sessions', getMyIdleSessions);
router.get('/reports/idle', authenticateRole('super_admin', 'admin'), getIdleReport);
router.get('/reports/idle/sessions', authenticateRole('super_admin', 'admin'), getIdleSessions);

const requireFro = (req, res, next) => {
  if (req.user.role === 'fro') return next();
  if (req.user.department && req.user.department.toLowerCase().trim() === 'fro') return next();
  return res.status(403).json({ message: 'FRO worker access required' });
};

// Self-resume must work for every telecaller regardless of role/department
// spelling in their token (requireFro below rejects non-'fro' roles, which
// made Play flaky per-FRO). It only ever touches the caller's own row.
router.post('/status/resume-self', authenticate, resumeOwnPause);
// There is deliberately no idle-resume route. It used to hand back a fresh
// 4-minute window without the FRO doing anything, which made the cost of
// idling optional. Recording a disposition is now the only way out of idle, and
// that path already commits the open period into the day (back-dated to the
// expiry, so the overrun is still charged). Do not re-add a resume affordance
// without changing that rule here, or the UI removal is only cosmetic and the
// endpoint stays callable.

router.use(requireFro);

router.get('/my-stations', getMyStations);
router.get('/dashboard', getDashboard);
router.get('/allotment-summary', getMyAllotmentSummary);
router.get('/my-performance', getMyPerformance);
router.get('/dashboard/collections', getMyCollections);
// Team-wise collection board for the FRO's Collection Race popup - the same board
// the NGO-admin header shows. Sits after router.use(requireFro) (line ~87), so only
// a real FRO account can reach it.
router.get('/dashboard/team-collection', getMyTeamsCollection);
router.get('/dashboard/suspense', getSuspenseReceipts);
router.post('/dashboard/suspense/:receiptId/claim', claimSuspenseReceipt);
router.get('/reactivated-donors', getReactivatedDonors);
router.get('/donors', getMyDonors);
router.get('/queue/current', (req, res, next) => {
  // Backend-authoritative "current donor" for the controlled queue: reuses the
  // getMyDonors pipeline (same scope/ordering/filtering/dedup) but returns only
  // the single next donor plus durable progress, so the front-end never picks
  // or skips the next donor itself.
  req.query = { ...req.query, queue_current: 'true', limit: undefined, offset: undefined };
  return getMyDonors(req, res).catch(next);
});
router.get('/transferred-leads', getTransferredLeads);
router.put('/donors/:id/status', updateDonorStatus);
router.put('/donors/:id/donor-type', updateDonorType);
router.put('/donors/:id/mark-seen', async (req, res) => {
  try {
    const { id } = req.params;
    const donorId = parseInt(id);
    const { ngo_id } = req.body;
    let query = db
      .from('fro_assignments')
      .update({ is_new: false })
      .eq('donor_id', donorId)
      .eq('fro_worker_id', req.user.id)
      .not('status', 'eq', 'reassigned');
    if (ngo_id) query = query.eq('ngo_id', ngo_id);
    const { error } = await query;
    if (error) throw error;
    return res.json({ message: 'Marked as seen' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});
router.get('/donors/:id/logs', getDonorLogs);
router.post('/donors/:id/logs', createDonorLogHandler);
router.post('/donors/:id/schedule', scheduleContact);
router.post('/upload-payment-screenshot', uploadPaymentScreenshot);
router.get('/scheduled', getFroScheduled);
router.get('/callbacks', getFroCallbacks);
router.get('/promises', getFroPromises);
router.get('/overdue', getFroOverdue);
router.put('/status', updateLiveStatus);
router.get('/progress', getMyProgress);
router.put('/progress', saveMyProgress);
router.get('/history', getMyHistory);
router.get('/target', getMyTarget);
router.post('/request-data', requestData);
router.get('/database-requests', getMyDataRequests);
router.get('/follow-ups', getFollowUps);
router.get('/lead-stats', getLeadStats);
router.get('/monthly-donors', getMonthlyDonors);
router.get('/donors/:id/history', getDonorHistory);
router.get('/donors/:id/full-history', getFullDonorHistory);
router.get('/donors/:id/donations', getDonorDonations);
router.get('/donors/:id/receipts', getDonorReceipts);
router.get('/search-donors', searchDonors);
router.get('/my-disposed-leads', getMyDisposedLeads);

router.get('/suspense', listFroSuspense);
router.get('/suspense/search-dispositions', searchFroDispositions);
router.get('/suspense/donor-search', searchSuspenseDonors);
router.put('/suspense/:id/resolve', resolveSuspenseEntry);

export default router;
