import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

// Role aliases that appear in the users table (case / wording variants). Normalizes
// so guards like authenticateRole('super_admin', 'admin', 'hr') also match 'HR',
// 'HR-Recruiter', 'FRO', 'Event Head', etc. stored in the database.
const ROLE_ALIASES = {
  'hr': 'hr',
  'hr-recruiter': 'recruiter',
  'fro': 'fro',
  'accounts': 'accounts',
  'accountant': 'accounts',
  'admin': 'admin',
  'administrator': 'admin',
  'ngo admin': 'admin',
  'ngo_admin': 'admin',
  'super_admin': 'super_admin',
  'superadmin': 'super_admin',
  'super admin': 'super_admin',
  'super-admin': 'super_admin',
  'sa': 'super_admin',
  'master': 'master',
  'recruiter': 'recruiter',
  'telecaller': 'telecaller',
  'leads': 'leads',
  'team_lead': 'team_lead',
  'worker': 'worker',
  'event_head': 'event_head',
  'event manager': 'event_manager',
  'event_manager': 'event_manager',
  'event head': 'event_head',
  'ngo': 'ngo',
  'whatsapp_crm': 'whatsapp_crm',
  'digital': 'digital',
  'developer': 'developers',
  'developers': 'developers',
  'agent': 'agent',
  'viewer': 'viewer',
};

export const normalizeRole = (role) => {
  if (role == null) return role;
  const s = String(role).trim().toLowerCase();
  return ROLE_ALIASES[s] || s;
};

const applyNormalizedRole = (decoded) => {
  if (decoded && decoded.role) decoded.role = normalizeRole(decoded.role);
  return decoded;
};

export const authenticateRole = (...allowedRoles) => {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }
    try {
      const decoded = applyNormalizedRole(jwt.verify(token, process.env.JWT_SECRET));
      if (!allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ message: `Access denied. Required role: ${allowedRoles.join(', ')}` });
      }
      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({ message: 'Invalid token' });
    }
  };
};

export const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { return res.status(401).json({ message: 'No token provided' }); }
  try {
    req.user = applyNormalizedRole(jwt.verify(token, process.env.JWT_SECRET));
    next();
  } catch { return res.status(401).json({ message: 'Invalid token' }); }
};

export const authenticateAdmin = authenticateRole('master', 'super_admin');
export const authenticateWorker = authenticateRole('worker', 'fro');

// ── UFS / Event Manager workspace ────────────────────────────────
// The client admits a user into EventHeadPanel when EITHER their role or their
// department matches (client/src/App.jsx ProtectedRoute: role list plus the
// `allowedRoles.includes(user.department)` fallback). An API guard that only
// looked at the role would 403 someone the UI already let in, and their team
// queue would silently render empty — so mirror both checks here.
const EVENT_TEAM_ROLES = new Set(['event_head', 'event_manager']);
// Resolver/admin roles keep full access even if their department happens to
// mention events, so they are never narrowed to the event team's queue.
const PRIVILEGED_ROLES = new Set(['super_admin', 'admin', 'master', 'accounts', 'user']);

export const isEventTeam = (user) => {
  if (!user) return false;
  const role = normalizeRole(user.role);
  if (PRIVILEGED_ROLES.has(role)) return false;
  if (EVENT_TEAM_ROLES.has(role)) return true;
  if (!user.department) return false;
  const dept = normalizeRole(String(user.department).trim().toLowerCase());
  return EVENT_TEAM_ROLES.has(dept) || dept.includes('event');
};

// Accounts/resolvers (full rights) OR the Event Manager team (own queue only).
export const authenticateAccountsOrEventTeam = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = applyNormalizedRole(jwt.verify(token, process.env.JWT_SECRET));
    const role = normalizeRole(decoded.role);
    if (role === 'accounts' || role === 'super_admin' || isEventTeam(decoded)) {
      req.user = decoded;
      return next();
    }
    return res.status(403).json({ message: 'Access denied' });
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Salary calculator app — Accounts department or super admin only.
export const authenticateSalary = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { return res.status(401).json({ message: 'No token provided' }); }
  try {
    const decoded = applyNormalizedRole(jwt.verify(token, process.env.JWT_SECRET));
    if (decoded.role !== 'accounts' && decoded.role !== 'super_admin') {
      return res.status(403).json({ message: 'Access denied. Accounts department or super admin only.' });
    }
    req.user = decoded;
    next();
  } catch { return res.status(401).json({ message: 'Invalid token' }); }
};
