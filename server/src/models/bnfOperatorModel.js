import crypto from 'crypto';
import db from '../config/db.js';

// Beneficiaries mobile-app operators, stored in their own bnf_operators table
// (not as worker rows). Ids are uuids so operator_assignments.operator_id FKs
// stay type-compatible with the legacy workers rows that were migrated over.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v.trim());

export const createBnfOperator = async (data) => {
  const row = { ...data };
  if (!row.id) row.id = crypto.randomUUID();
  const { data: result, error } = await db
    .from('bnf_operators')
    .insert([row])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getBnfOperatorById = async (id) => {
  if (!isUuid(id)) return null;
  const { data, error } = await db
    .from('bnf_operators')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

export const getBnfOperatorByLoginId = async (login_id) => {
  const { data, error } = await db
    .from('bnf_operators')
    .select('*')
    .eq('login_id', login_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

export const listBnfOperators = async () => {
  const { data, error } = await db
    .from('bnf_operators')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const updateBnfOperator = async (id, updates) => {
  const { data, error } = await db
    .from('bnf_operators')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Resolve the operator backing a token — prefer the exact login_id row, fall
// back to uuid lookup (mirrors getWorkerBySession).
export const getBnfOperatorBySession = async (user) => {
  if (user && user.login_id) {
    const byLogin = await getBnfOperatorByLoginId(user.login_id);
    if (byLogin) return byLogin;
  }
  if (user && isUuid(user.id)) return getBnfOperatorById(user.id);
  return null;
};