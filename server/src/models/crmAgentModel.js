import bcrypt from 'bcryptjs';
import db, { sql } from '../config/db.js';

// CRM login agents ("Agent N").
//
// A login agent is a person who works one FRO's data without holding the FRO's
// own credentials. See migrations/172_crm_agents.sql for why this is a dedicated
// table rather than users.role='agent' (59 live WhatsApp agent accounts) or
// worker_agent_assignments (the WhatsApp routing table).
//
// Invariants the rest of the feature relies on:
//   - login_id is immutable and never reused (allocated from crm_agent_sequence).
//   - one ACTIVE agent per FRO, enforced by a partial unique index.
//   - the agent's uuid never keys a live row or time session; those carry FKs to
//     workers(id), so an agent session files under the ASSIGNED FRO instead.

// The admin-chosen default. Weak by design and a standing risk: it ships because
// that is what was asked for. Only ever stored hashed, and handed back once at
// creation or reset.
export const DEFAULT_AGENT_PASSWORD = '123456';

const AGENT_SELECT = `
  SELECT a.id, a.login_id, a.label, a.worker_id, a.ngo_id, a.is_active,
         a.must_change_password, a.created_at, a.updated_at,
         w.name AS worker_name, w.login_id AS worker_login_id,
         w.ngo_id AS worker_ngo_id,
         w.is_active AS worker_is_active, w.employment_status AS worker_employment_status,
         (SELECT count(*)::int
            FROM fro_station_assignments s
           WHERE s.fro_worker_id = w.id) AS station_count
    FROM crm_agents a
    LEFT JOIN workers w ON w.id = a.worker_id
`;

// Give the label a worker_aliases row so that bulk imports naming "Agent 2" in
// the FRO column resolve to a real worker (see workerNameMatch.js).
//
// This is NOT the receipt-credit mechanism. A receipt is credited through
// fro_donor_logs.fro_worker_id, a hard foreign key written at collection time,
// which for an agent session is already the FRO's id. Repointing this alias
// therefore does not re-attribute a single historical receipt.
//
// worker_aliases has no uniqueness constraint on alias_name (its PK is id), so
// the guard is an explicit read.
const ensureAgentAlias = async (txFrom, label, workerId) => {
  const { data: existing, error: exErr } = await txFrom('worker_aliases')
    .select('id, worker_id')
    .ilike('alias_name', label)
    .limit(1);
  if (exErr) throw exErr;

  if (existing && existing.length > 0) {
    if (String(existing[0].worker_id) === String(workerId)) return;
    // Two agents must never share a label, because it is also how imports
    // resolve a name to one person. Labels come from a never-reused sequence,
    // so this can only mean the row predates that invariant.
    throw Object.assign(
      new Error(`The label "${label}" is already in use for a different FRO.`),
      { code: 'AGENT_LABEL_TAKEN' }
    );
  }
  const { error } = await txFrom('worker_aliases').insert({ alias_name: label, worker_id: workerId });
  if (error) throw error;
};

// Reassignment follows the agent to its new FRO.
//
// Safe because of the note above: history is held by fro_worker_id, not by this
// row. Leaving the alias behind would be worse, not safer — imports naming the
// agent would keep resolving to the FRO they have been moved away from, and a
// receipt written after the move would point at an agent nobody holds.
const moveAgentAlias = async (txFrom, label, workerId) => {
  const { data: existing, error: exErr } = await txFrom('worker_aliases')
    .select('id, worker_id')
    .ilike('alias_name', label)
    .limit(1);
  if (exErr) throw exErr;

  if (existing && existing.length > 0) {
    if (String(existing[0].worker_id) === String(workerId)) return;
    const { error } = await txFrom('worker_aliases')
      .update({ worker_id: workerId })
      .eq('id', existing[0].id);
    if (error) throw error;
    return;
  }
  const { error } = await txFrom('worker_aliases').insert({ alias_name: label, worker_id: workerId });
  if (error) throw error;
};

// Burn the next handle and return it.
//
// A single UPDATE on one row is self-serialising: Postgres holds the row lock
// for the duration of the statement, so two admins creating an agent at the same
// moment receive different numbers instead of colliding on the unique index.
// The number is consumed even if the surrounding creation later fails, and that
// is deliberate — see the comment on crm_agent_sequence in the migration.
const allocateLoginSequence = async () => {
  const rows = await sql(
    'UPDATE crm_agent_sequence SET last_value = last_value + 1 WHERE id = 1 RETURNING last_value'
  );
  const allocated = Number(rows?.[0]?.last_value ?? 0);
  if (!Number.isFinite(allocated) || allocated < 1) {
    throw Object.assign(new Error('Could not allocate an agent login id.'), { code: 'AGENT_SEQ_FAILED' });
  }
  return allocated;
};

// Create one agent: allocate the next handle, hash the password, and register
// the label against the FRO.
//
// `label` is derived from the allocated handle unless overridden, so the two stay
// consistent by default and "Agent 2" is always the login_id agent2.
export const createAgent = async ({
  workerId,
  ngoId = null,
  password = DEFAULT_AGENT_PASSWORD,
  label = null,
  loginId = null,
  mustChangePassword = false,
  createdBy = null,
}) => {
  const wid = String(workerId ?? '').trim();
  // Unassigned agents are allowed by default: migration 173 dropped the NOT NULL on
  // worker_id so handles can be bulk-created first and covered later via
  // reassignAgentWorker. They simply cannot log in (authenticateAgent rejects
  // them via a LEFT JOIN that yields no worker row).
  const passwordHash = await bcrypt.hash(String(password), 10);
  const explicitLoginId = String(loginId ?? '').trim() || null;
  const allocated = explicitLoginId ? 0 : await allocateLoginSequence();
  const finalLoginId = String(explicitLoginId || `agent${allocated}`).trim();
  const explicitLabel = String(label ?? '').trim();
  const labelFromLoginId = explicitLoginId ? explicitLoginId.replace(/^agent(\d+)$/i, 'Agent $1') : null;
  const finalLabel = explicitLabel || labelFromLoginId || `Agent ${allocated}`;

  // The insert and the alias registration have to land together: an alias with no
  // agent row would resolve receipts for an agent who does not exist, and an agent
  // row with no alias would stamp receipts the accounts page cannot attribute.
  return db.transaction(async ({ from: txFrom }) => {
    if (wid) {
      const { data: covered } = await txFrom('crm_agents')
        .select('id, login_id, label')
        .eq('worker_id', wid)
        .eq('is_active', true)
        .maybeSingle();
      if (covered) {
        throw Object.assign(new Error('That FRO already has an active agent.'), { code: 'AGENT_WORKER_TAKEN' });
      }

      await ensureAgentAlias(txFrom, finalLabel, wid);
    }

    const { data, error } = await txFrom('crm_agents')
      .insert({
        login_id: finalLoginId,
        password_hash: passwordHash,
        label: finalLabel,
        worker_id: wid || null,
        ngo_id: ngoId,
        is_active: true,
        must_change_password: !!mustChangePassword,
        created_by: createdBy,
      })
      .select('id, login_id, label, worker_id, ngo_id, is_active, must_change_password, created_at, updated_at')
      .single();
    if (error) throw error;
    return data;
  });
};

// The login lookup. Password included because this is the only path that
// authenticates an agent; nothing else should read password_hash.
export const getAgentByLoginId = async (loginId) => {
  const id = String(loginId ?? '').trim();
  if (!id) return null;
  const rows = await sql(
    `SELECT a.id, a.login_id, a.password_hash, a.label, a.worker_id, a.ngo_id,
            a.is_active, a.must_change_password,
            w.name AS worker_name, w.login_id AS worker_login_id,
            w.ngo_id AS worker_ngo_id, w.department AS worker_department,
            w.is_active AS worker_is_active,
            w.employment_status AS worker_employment_status
        FROM crm_agents a
        LEFT JOIN workers w ON w.id = a.worker_id
       WHERE lower(a.login_id) = lower($1)
      LIMIT 1`,
    [id]
  );
  return rows?.[0] || null;
};

export const getAgentById = async (id) => {
  const aid = String(id ?? '').trim();
  if (!aid) return null;
  const rows = await sql(`${AGENT_SELECT} WHERE a.id = $1 LIMIT 1`, [aid]);
  return rows?.[0] || null;
};

// Which agent, if any, currently holds this FRO. The login guard for "you are
// covered, sign in as your agent" and the block on the FRO's own login both read
// this.
export const getActiveAgentByWorkerId = async (workerId) => {
  const wid = String(workerId ?? '').trim();
  if (!wid) return null;
  const rows = await sql(`${AGENT_SELECT} WHERE a.worker_id = $1 AND a.is_active LIMIT 1`, [wid]);
  return rows?.[0] || null;
};

// `ngoIds` scopes to the NGOs an admin can already reach, so the Agents page cannot
// be used to enumerate the whole organisation's field staff from an account with
// visibility of two NGOs. Takes the whole list rather than one id: an NGO admin
// routinely has several, and filtering on only the first would hide the other
// NGOs' field staff.
//
// The scope is tested against the WORKER's ngo_id rather than the agent's own
// column: an agent inherits its FRO's NGO at creation, and testing both would let
// a stale agent.ngo_id hide a reassigned agent (or show one the admin lost access
// to). FROs with no NGO set are always included — they belong to no NGO, so
// excluding them would hide real field staff rather than protect anything.
export const listAgents = async ({ ngoIds = [], includeInactive = true } = {}) => {
  const ids = (Array.isArray(ngoIds) ? ngoIds : [ngoIds]).filter(Boolean);
  const params = [];
  const where = [];
  if (ids.length > 0) {
    params.push(ids);
    where.push(`(w.ngo_id = ANY($${params.length}::uuid[]) OR w.ngo_id IS NULL)`);
  }
  if (!includeInactive) where.push('a.is_active');
  const rows = await sql(
    `${AGENT_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.is_active DESC,
               (NULLIF(regexp_replace(a.login_id, '\\D', '', 'g'), ''))::int DESC NULLS LAST,
               a.created_at DESC
      LIMIT 500`,
    params
  );
  return rows;
};

// Activate / deactivate. Deactivating frees the FRO for a new agent (the partial
// unique index only counts active rows) while keeping the row as an audit trail
// of the handle, so "Agent 2" can never later mean somebody else.
export const setAgentActive = async (id, isActive) => {
  const { data, error } = await db
    .from('crm_agents')
    .update({ is_active: !!isActive, updated_at: new Date().toISOString() })
    .eq('id', String(id))
    .select('id, login_id, label, worker_id, is_active')
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Point an existing agent at a different FRO. The label follows, so the alias
// that resolves receipts back to a worker moves with it.
export const reassignAgentWorker = async (id, workerId) => {
  const wid = String(workerId ?? '').trim();
  return db.transaction(async ({ from: txFrom }) => {
    const { data: agent, error: aErr } = await txFrom('crm_agents')
      .select('id, login_id, label, worker_id')
      .eq('id', String(id))
      .maybeSingle();
    if (aErr) throw aErr;
    if (!agent) return null;

    const { data: taken } = await txFrom('crm_agents')
      .select('id, login_id, label, worker_id')
      .eq('worker_id', wid)
      .eq('is_active', true)
      .neq('id', String(id))
      .maybeSingle();

    if (taken) {
      // Swap, not reject: Agent 2 moves to Neha, Agent 27 takes Mahima.
      // Three steps because the partial unique index on worker_id allows only
      // one active agent per FRO at any statement boundary.
      const now = new Date().toISOString();

      // worker_id is NOT NULL, so free the slot by deactivating the other
      // agent first — the partial unique index on worker_id only counts
      // is_active rows, so Neha's slot clears without nulling the column.
      const { error: e1 } = await txFrom('crm_agents')
        .update({ is_active: false, updated_at: now })
        .eq('id', taken.id);
      if (e1) throw e1;

      const { error: e2 } = await txFrom('crm_agents')
        .update({ worker_id: wid, updated_at: now })
        .eq('id', String(id));
      if (e2) throw e2;

      const { error: e3 } = await txFrom('crm_agents')
        .update({ worker_id: agent.worker_id, is_active: true, updated_at: now })
        .eq('id', taken.id);
      if (e3) throw e3;

      await moveAgentAlias(txFrom, agent.label, wid);
      if (agent.worker_id) {
        await moveAgentAlias(txFrom, taken.label, agent.worker_id);
      } else {
        // The current agent was unassigned, so the swapped agent is losing its
        // FRO and its alias has to go with it.
        await txFrom('worker_aliases').delete().ilike('alias_name', taken.label);
      }

      const { data: updated, error: uErr } = await txFrom('crm_agents')
        .update({ worker_id: wid, updated_at: now })
        .eq('id', String(id))
        .select('id, login_id, label, worker_id, is_active')
        .single();
      if (uErr) throw uErr;
      return { ...updated, swapped: true, swappedWith: taken.id };
    }

    // The label travels with the agent rather than staying with the old FRO.
    await moveAgentAlias(txFrom, agent.label, wid);

    const { data, error } = await txFrom('crm_agents')
      .update({ worker_id: wid, updated_at: new Date().toISOString() })
      .eq('id', String(id))
      .select('id, login_id, label, worker_id, is_active')
      .single();
    if (error) throw error;
    return data;
  });
};

// Password reset. Returns nothing sensitive; the caller renders the plaintext it
// already holds exactly once.
export const setAgentPasswordHash = async (id, passwordHash) => {
  const { data, error } = await db
    .from('crm_agents')
    .update({ password_hash: passwordHash, must_change_password: false, updated_at: new Date().toISOString() })
    .eq('id', String(id))
    .select('id, login_id, label, worker_id, is_active')
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Hard delete. Receipts are untouched: they stamp imposter_name 'Agent 2' as
// free text and their credit lives on fro_worker_id, so deleting the row
// re-attributes nothing. The alias row must go with it, otherwise imports
// naming this agent would keep resolving to its FRO after the login is gone.
export const deleteAgent = async (id) => {
  const agent = await getAgentById(id);
  if (!agent) return null;
  return db.transaction(async ({ from: txFrom }) => {
    const { error: aliasErr } = await txFrom('worker_aliases')
      .delete()
      .ilike('alias_name', agent.label)
      .eq('worker_id', agent.worker_id);
    if (aliasErr) throw aliasErr;
    const { error } = await txFrom('crm_agents').delete().eq('id', String(id));
    if (error) throw error;
    return { deleted: true, id: String(id) };
  }).then(async (result) => {
    // Re-align the handle sequence with what is still alive. Deleting a
    // middle agent must not bump the counter; deleting the last ones frees
    // 1 so the next create returns agent1 again.
    try {
      await sql(
        `UPDATE crm_agent_sequence
            SET last_value = COALESCE((
              SELECT MAX(CAST(regexp_replace(login_id, '[^0-9]', '', 'g') AS integer))
                FROM crm_agents
               WHERE login_id ~ '^agent[0-9]+$'
            ), 0)
          WHERE id = 1`
      );
    } catch (e) {
      console.warn('[agents] sequence resync after delete failed:', e?.message || e);
    }
    return result;
  });
};

// Authenticate an agent and hand back the row to log in with. Kept next to the
// model so the password comparison cannot drift from the lookup that found it.
export const authenticateAgent = async (loginId, password) => {
  const agent = await getAgentByLoginId(loginId);
  if (!agent) return { ok: false, reason: 'not_found' };
  if (!agent.is_active) return { ok: false, reason: 'inactive' };
  if (!agent.worker_is_active || agent.worker_employment_status === 'terminated') {
    return { ok: false, reason: 'worker_inactive' };
  }
  const match = await bcrypt.compare(String(password ?? ''), agent.password_hash);
  if (!match) return { ok: false, reason: 'bad_password' };
  return { ok: true, agent };
};