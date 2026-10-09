import bcrypt from 'bcryptjs';
import db, { sql } from '../config/db.js';
import { getUserNgoAccess } from '../models/userNgoAccessModel.js';
import { getWorkerById } from '../models/workerModel.js';
import {
  listAgents,
  createAgent,
  setAgentActive,
  reassignAgentWorker,
  setAgentPasswordHash,
  deleteAgent,
  DEFAULT_AGENT_PASSWORD,
} from '../models/crmAgentModel.js';

// Management of CRM login agents ("Agent N").
//
// Guarded by authenticateRole('admin', 'super_admin') at the router. Every handler
// here hands out or changes a credential that reaches an FRO's entire account, so
// it is deliberately not open to the broader roles that can read station and
// donor data.
//
// The password is accepted and echoed back exactly once, at creation and at reset.
// It is hashed before it reaches the database and is never logged.

const errMessage = (e, fallback) => e?.message || fallback;

// Codes the model raises for conditions the caller can explain better than a
// generic 500 can.
const STATUS_FOR_CODE = {
  AGENT_WORKER_TAKEN: 409,
  AGENT_LABEL_TAKEN: 409,
  AGENT_BAD_REQUEST: 400,
  AGENT_SEQ_FAILED: 500,
};

// The FROs an admin may hand to an agent.
//
// Scoped to the NGOs the caller can already reach, so this page cannot be used as a
// way to enumerate the whole organisation's field staff from an account that has
// visibility of two NGOs.
const accessibleNgoIds = async (req) => {
  const access = await getUserNgoAccess(req.user.id, req.user.role);
  const ids = access.map((a) => a.ngo_id).filter(Boolean);
  if (ids.length === 0 && req.user.ngo_id) ids.push(req.user.ngo_id);
  return ids;
};

const isFroWorker = (w) => String(w?.department || '').toLowerCase().trim() === 'fro';

// ─── Read ───────────────────────────────────────────────────────────────────

export const getCrmAgents = async (req, res) => {
  try {
    const ngoIds = await accessibleNgoIds(req);
    // Empty scope means "no restriction I can apply", so list everything rather
    // than showing a super-admin an empty page that reads as "no agents exist".
    const agents = await listAgents({ ngoIds });
    return res.json({ agents, scope_ngo_ids: ngoIds });
  } catch (error) {
    return res.status(500).json({ message: errMessage(error, 'Could not load agents') });
  }
};

// FROs available to assign, annotated with whoever holds them now. Powers the
// assign dropdown on the Agents page and is the reason the page does not reuse
// GET /stations — that endpoint computes per-station donor counts, which is a lot
// of work to render a list of names.
export const getCrmAgentFroOptions = async (req, res) => {
  try {
    const ngoIds = await accessibleNgoIds(req);
    const params = [];
    let scope = '';
    if (ngoIds.length > 0) {
      params.push(ngoIds);
      scope = `AND (w.ngo_id = ANY($1::uuid[]) OR w.ngo_id IS NULL)`;
    }
    const rows = await sql(
      `SELECT w.id, w.name, w.login_id, w.ngo_id, w.is_active,
              w.employment_status,
              (SELECT count(*)::int FROM fro_station_assignments s
                WHERE s.fro_worker_id = w.id) AS station_count,
              a.login_id AS agent_login_id, a.label AS agent_label, a.id AS agent_id
         FROM workers w
         LEFT JOIN LATERAL (
           SELECT id, login_id, label FROM crm_agents
            WHERE worker_id = w.id AND is_active LIMIT 1
         ) a ON TRUE
        WHERE lower(btrim(coalesce(w.department, ''))) = 'fro'
          ${scope}
        ORDER BY a.id IS NOT NULL, w.name ASC
        LIMIT 500`,
      params
    );
    return res.json({
      workers: (rows || []).map((w) => ({
        ...w,
        assignable: !w.agent_id,
        unavailable_reason: w.agent_id
          ? `Already covered by ${w.agent_label}`
          : (w.is_active === false || w.employment_status === 'terminated'
            ? 'FRO account is not active'
            : null),
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: errMessage(error, 'Could not load FROs') });
  }
};

// ─── Write ──────────────────────────────────────────────────────────────────

// Closing an FRO's live CRM sessions when they are covered.
//
// Without this the feature is only half-enforced: the login guard blocks a NEW
// direct login, but the FRO may already hold a 24h token from earlier in the day,
// and nothing would stop them continuing to work their own account. Stamping
// logged_out_at is what the heartbeat's force-logout guard already watches, so the
// next poll boots their tab — no new mechanism needed, and the guard compares
// against token iat so it cannot bounce a session opened after this point.
const closeFroSessions = async (workerId) => {
  try {
    await sql(
      'UPDATE auth_sessions SET logged_out_at = now() WHERE user_id = $1 AND logged_out_at IS NULL',
      [String(workerId)]
    );
  } catch (e) {
    // auth_sessions may be absent until migration 125. The login guard still holds.
    console.warn('[agents] could not close FRO session:', e?.message || String(e));
  }
};

export const createCrmAgent = async (req, res) => {
  try {
    const workerId = String(req.body?.worker_id || '').trim();
    const worker = workerId ? await getWorkerById(workerId) : null;
    if (workerId && !worker) return res.status(404).json({ message: 'FRO not found.' });
    if (worker && !isFroWorker(worker)) return res.status(400).json({ message: 'Only FRO accounts can be covered by an agent.' });

    const ngoIds = await accessibleNgoIds(req);
    if (worker && ngoIds.length > 0 && worker.ngo_id && !ngoIds.includes(worker.ngo_id)) {
      return res.status(403).json({ message: 'That FRO belongs to an NGO you do not have access to.' });
    }

    const password = String(req.body?.password || DEFAULT_AGENT_PASSWORD);
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    // created_by is left null deliberately: the FK points at users(id), but an NGO
    // admin signs in through the workers table, so req.user.id is a workers.id and
    // the insert would fail on the constraint. Recorded in the audit trail via
    // created_at plus the operator name on the work-as session instead.
    const agent = await createAgent({
      workerId: worker?.id || null,
      ngoId: worker?.ngo_id || null,
      password,
      label: req.body?.label ? String(req.body.label).trim() : null,
      loginId: req.body?.login_id ? String(req.body.login_id).trim() : null,
      mustChangePassword: !!req.body?.must_change_password,
      createdBy: null,
    });

    if (worker) await closeFroSessions(worker.id);

    return res.status(201).json({
      agent,
      credentials: { login_id: agent.login_id, password },
      message: worker ? `${agent.label} created for ${worker.name}` : `${agent.label} created`,
    });
  } catch (error) {
    const status = STATUS_FOR_CODE[error?.code] || 500;
    return res.status(status).json({ message: errMessage(error, 'Could not create agent') });
  }
};

// Bulk: accept a list of login ids, create each as an unassigned agent. No FRO
// required up front - assign later via Reassign. Any that already exist are
// skipped and reported rather than crashing the whole batch.
export const bulkCreateCrmAgents = async (req, res) => {
  try {
    const list = Array.isArray(req.body?.login_ids)
      ? req.body.login_ids
      : String(req.body?.login_ids || '')
          .split(/[\n,;\s]+/)
          .filter(Boolean);
    if (list.length === 0) return res.status(400).json({ message: 'Paste at least one login id.' });

    const password = String(req.body?.password || DEFAULT_AGENT_PASSWORD);
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const created = [];
    const errors = [];
    for (const rawId of list) {
      const loginId = String(rawId).trim();
      if (!loginId) continue;
      try {
        const m = loginId.match(/^agent(\d+)$/i);
        const agent = await createAgent({
          loginId,
          workerId: null,
          ngoId: null,
          password,
          label: m ? `Agent ${Number(m[1])}` : null,
          mustChangePassword: !!req.body?.must_change_password,
          createdBy: null,
        });
        created.push({ login_id: agent.login_id, label: agent.label });
      } catch (e) {
        errors.push({ login_id: loginId, message: errMessage(e, 'Could not create') });
      }
    }

    return res.status(201).json({ created, errors, message: `${created.length} agent(s) created, ${errors.length} failed.` });
  } catch (error) {
    return res.status(500).json({ message: errMessage(error, 'Bulk create failed') });
  }
};

export const updateCrmAgentStatus = async (req, res) => {
  try {
    const isActive = req.body?.is_active === true;
    const agent = await setAgentActive(req.params.id, isActive);
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });
    // Deactivating frees the FRO to be covered again and lets them sign back in as
    // themselves; their next login reopens the session this stamping closed.
    return res.json({
      agent,
      message: isActive ? `${agent.label} reactivated` : `${agent.label} deactivated`,
    });
  } catch (error) {
    return res.status(STATUS_FOR_CODE[error?.code] || 500).json({
      message: errMessage(error, 'Could not update agent'),
    });
  }
};

export const updateCrmAgentAssignment = async (req, res) => {
  try {
    const workerId = String(req.body?.worker_id || '').trim();
    if (!workerId) return res.status(400).json({ message: 'Select an FRO.' });

    const worker = await getWorkerById(workerId);
    if (!worker) return res.status(404).json({ message: 'FRO not found.' });
    if (!isFroWorker(worker)) return res.status(400).json({ message: 'Only FRO accounts can be covered by an agent.' });

    const ngoIds = await accessibleNgoIds(req);
    if (ngoIds.length > 0 && worker.ngo_id && !ngoIds.includes(worker.ngo_id)) {
      return res.status(403).json({ message: 'That FRO belongs to an NGO you do not have access to.' });
    }

    const previous = await sql('SELECT worker_id FROM crm_agents WHERE id = $1', [String(req.params.id)]);
    const agent = await reassignAgentWorker(req.params.id, worker.id);
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });

    // Close the new FRO's sessions, and the old one's too: they are no longer
    // covered by anybody, and a token that outlives its cover is exactly the leak
    // this feature exists to close. Both reopen on next login.
    await closeFroSessions(worker.id);
    if (previous?.[0]?.worker_id) await closeFroSessions(previous[0].worker_id);

    return res.json({
      agent,
      swapped: !!agent?.swapped,
      message: agent?.swapped
        ? `${agent.label} now covers ${worker.name}; its old FRO moved to the other agent`
        : `${agent.label} now covers ${worker.name}`,
    });
  } catch (error) {
    return res.status(STATUS_FOR_CODE[error?.code] || 500).json({
      message: errMessage(error, 'Could not reassign agent'),
    });
  }
};

// Reset to a new password. Returns the plaintext once, same contract as creation.
export const resetCrmAgentPassword = async (req, res) => {
  try {
    const password = String(req.body?.password || DEFAULT_AGENT_PASSWORD);
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }
    const existing = await sql('SELECT login_id FROM crm_agents WHERE id = $1', [String(req.params.id)]);
    if (!existing?.[0]) return res.status(404).json({ message: 'Agent not found.' });

    const hash = await bcrypt.hash(password, 10);
    // Clears must_change_password, since whatever it was prompting for has now
    // been answered by this reset.
    const agent = await setAgentPasswordHash(req.params.id, hash);
    return res.json({
      agent,
      credentials: { login_id: agent.login_id, password },
      message: `Password reset for ${agent.label}`,
    });
  } catch (error) {
    return res.status(STATUS_FOR_CODE[error?.code] || 500).json({
      message: errMessage(error, 'Could not reset password'),
    });
  }
};

// ─── Self-service ───────────────────────────────────────────────────────────

// What the signed-in session actually is.
//
// The FRO panel already knows it is in a work-as session, but it cannot tell
// whether the person typing is an agent (bound to one FRO, cannot switch) or an
// admin mid-cover (may switch). The difference decides whether to offer the
// account switcher at all, so it is worth answering explicitly.
export const getMyCrmAgentContext = async (req, res) => {
  try {
    const agentId = req.user?.agent_user_id || null;
    if (!agentId) {
      return res.json({ is_agent: false, can_switch_fro: true });
    }
    const rows = await sql(
      `SELECT a.login_id, a.label, a.is_active, a.must_change_password,
              w.id AS worker_id, w.name AS worker_name
         FROM crm_agents a
         JOIN workers w ON w.id = a.worker_id
        WHERE a.id = $1`,
      [String(agentId)]
    );
    const agent = rows?.[0] || null;
    return res.json({
      is_agent: true,
      can_switch_fro: false,
      agent: agent
        ? {
            login_id: agent.login_id,
            label: agent.label,
            is_active: agent.is_active,
            must_change_password: agent.must_change_password,
            fro: { id: agent.worker_id, name: agent.worker_name },
          }
        : null,
    });
  } catch (error) {
    return res.status(500).json({ message: errMessage(error, 'Could not read agent context') });
  }
};

// Force-logout every session belonging to an agent. The heartbeat already 401s a
// deactivated agent on its next poll, so this exists for the case where the admin
// needs the guarantee immediately rather than within a poll interval.
export const forceLogoutCrmAgent = async (req, res) => {
  try {
    const agentId = String(req.params.id);
    const rows = await sql('SELECT worker_id, label FROM crm_agents WHERE id = $1', [agentId]);
    const agent = rows?.[0];
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });

    await db
      .from('auth_sessions')
      .update({ logged_out_at: new Date().toISOString() })
      .eq('user_id', String(agent.worker_id))
      .is('logged_out_at', null);

    return res.json({ message: `${agent.label} signed out` });
  } catch (error) {
    return res.status(500).json({ message: errMessage(error, 'Could not sign out agent') });
  }
};

// Permanent removal. Prefer deactivate for everyday cases: delete is for
// correcting a mistake (wrong FRO, duplicate) because it also frees the
// login_id sequence position's alias row and leaves no deactivated shell.
export const deleteCrmAgent = async (req, res) => {
  try {
    const removed = await deleteAgent(String(req.params.id));
    if (!removed) return res.status(404).json({ message: 'Agent not found.' });
    return res.json({ message: 'Agent deleted.' });
  } catch (error) {
    return res.status(400).json({ message: errMessage(error, 'Could not delete agent') });
  }
};
