// froReportController — historical idle reporting over fro_time_sessions.
//
// Two audiences:
//   - the FRO themself (self-scoped, resolved from the token), and
//   - admins (super_admin / ngo admin) who may read any FRO within their NGOs.
//
// Every figure comes from the authoritative interval ledger via froTimeReport;
// fro_daily_stats is never read as history. Day boundaries are IST and are handled
// by the splitter, so a session crossing midnight or a month boundary is billed
// correctly to each side.
import db from '../config/db.js';
import { getUserNgoAccess } from '../models/userNgoAccessModel.js';
import { splitWorkerContext } from '../utils/workAs.js';
import { istDateStr } from '../utils/froTimeState.js';
import {
  getIdleReportForWorker,
  getIdleSessionsForDay,
  getFroIdleTotalsForRange,
} from '../services/froTimeReport.js';
import { getFroWorkersByNgo } from './ngoAdminController.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Resolve {from, to} inclusive IST dates from ?month= or ?from=&to=. */
function resolveRange(query = {}, nowMs = Date.now()) {
  let { from, to, month } = query;
  if ((!from || !to) && month && MONTH_RE.test(month)) {
    from = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    to = `${month}-${String(last).padStart(2, '0')}`;
  }
  const today = istDateStr(new Date(nowMs));
  if (!from || !DATE_RE.test(from)) from = `${today.slice(0, 7)}-01`;
  if (!to || !DATE_RE.test(to)) to = today;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

/** FRO worker ids visible to this admin (all FROs when super_admin). */
async function accessibleFroIds(req) {
  const isSuper = req.user.role === 'super_admin';
  const access = await getUserNgoAccess(req.user.id, req.user.role);
  const ngoIds = access.map((a) => a.ngo_id).filter(Boolean);
  if (!isSuper && ngoIds.length === 0 && req.user.ngo_id) ngoIds.push(req.user.ngo_id);
  if (isSuper && ngoIds.length === 0) {
    const { data } = await db.from('workers').select('id').eq('department', 'FRO').eq('is_test', false);
    return { isSuper, ids: (data || []).map((w) => String(w.id)), workers: data || [] };
  }
  const lists = await Promise.all(ngoIds.map((id) => getFroWorkersByNgo(id)));
  const byId = new Map();
  for (const w of lists.flat()) byId.set(String(w.id), w);
  return { isSuper, ids: [...byId.keys()], workers: [...byId.values()] };
}

// ── Self ────────────────────────────────────────────────────────

export const getMyIdleReport = async (req, res) => {
  try {
    const { human } = splitWorkerContext(req.user);
    const { from, to } = resolveRange(req.query);
    const report = await getIdleReportForWorker({ workerId: human.id, from, to });
    return res.json({ worker_id: human.id, from, to, ...report });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyIdleSessions = async (req, res) => {
  try {
    const { human } = splitWorkerContext(req.user);
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : istDateStr();
    const data = await getIdleSessionsForDay({ workerId: human.id, date });
    return res.json({ worker_id: human.id, date, ...data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ── Admin ───────────────────────────────────────────────────────

export const getIdleReport = async (req, res) => {
  try {
    const { from, to } = resolveRange(req.query);
    const workerId = req.query.worker_id ? String(req.query.worker_id) : null;

    if (workerId) {
      const { isSuper, ids } = await accessibleFroIds(req);
      if (!isSuper && !ids.includes(workerId)) {
        return res.status(403).json({ message: 'FRO not in your NGO' });
      }
      const report = await getIdleReportForWorker({ workerId, from, to });
      return res.json({ worker_id: workerId, from, to, ...report });
    }

    // No worker selected: one total per FRO, straight from the ledger (single
    // aggregate query — never ship every session to the client).
    const { workers } = await accessibleFroIds(req);
    const ids = workers.map((w) => String(w.id));
    const totals = await getFroIdleTotalsForRange(ids, from, to);
    const rows = workers
      .map((w) => ({
        worker_id: String(w.id),
        name: w.name || w.login_id || 'Unknown',
        login_id: w.login_id || null,
        ngo_id: w.ngo_id || null,
        total_idle_seconds: totals[String(w.id)] || 0,
      }))
      .sort((a, b) => b.total_idle_seconds - a.total_idle_seconds);

    const total = rows.reduce((acc, r) => acc + r.total_idle_seconds, 0);
    return res.json({ from, to, total_idle_seconds: total, fros: rows });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getIdleSessions = async (req, res) => {
  try {
    const workerId = req.query.worker_id ? String(req.query.worker_id) : null;
    if (!workerId) return res.status(400).json({ message: 'worker_id is required' });
    const { isSuper, ids } = await accessibleFroIds(req);
    if (!isSuper && !ids.includes(workerId)) {
      return res.status(403).json({ message: 'FRO not in your NGO' });
    }
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : istDateStr();
    const data = await getIdleSessionsForDay({ workerId, date });
    return res.json({ worker_id: workerId, date, ...data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
