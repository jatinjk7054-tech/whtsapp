import db from '../config/db.js';

export const createImpersonationCode = async ({ code, ngo_id, created_by, created_by_name, expires_at }) => {
  const { data, error } = await db
    .from('impersonation_codes')
    .insert([{ code, ngo_id, created_by, created_by_name, expires_at }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Find a code that is still valid. Codes are validated by code+expiry+is_used only
// (ngo_id filtering removed to avoid mismatches when FRO generates codes during impersonation).
export const findValidImpersonationCode = async (code) => {
  const { data, error } = await db
    .from('impersonation_codes')
    .select('*')
    .eq('code', code)
    .eq('is_used', false)
    .gt('expires_at', new Date().toISOString())
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
};

export const markImpersonationCodeUsed = async (id, usedBy) => {
  const { data, error } = await db
    .from('impersonation_codes')
    .update({ is_used: true, used_at: new Date().toISOString(), used_by: usedBy })
    .eq('id', id)
    .eq('is_used', false)
    .select()
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const listImpersonationCodes = async (limit = 50) => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 60 * 1000);

  const { data, error } = await db
    .from('impersonation_codes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit * 3);

  if (error) throw error;

  return (data || []).filter(code => {
    const isActive = !code.is_used && new Date(code.expires_at) > now;
    const isRecent = new Date(code.created_at) > cutoff;
    return isActive || isRecent;
  }).slice(0, limit);
};

export const listAllImpersonationCodes = async () => {
  const { data, error } = await db
    .from('impersonation_codes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};
