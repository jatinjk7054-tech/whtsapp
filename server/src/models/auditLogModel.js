import db from '../config/db.js';

export const logAuditEvents = async (entries) => {
  const rows = (entries || []).map((e) => ({
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    beneficiary_id: e.beneficiary_id,
    action: e.action,
    details: e.details ? JSON.stringify(e.details) : null,
    performed_by: e.performed_by,
    performed_at: new Date().toISOString(),
  }));
  if (rows.length === 0) return [];
  const { data, error } = await db
    .from('beneficiary_audit_logs')
    .insert(rows)
    .select('*');
  if (error) throw error;
  return data || [];
};

export const logAuditEvent = async ({ entity_type, entity_id, beneficiary_id, action, details, performed_by }) => {
  const { data, error } = await db
    .from('beneficiary_audit_logs')
    .insert({
      entity_type,
      entity_id,
      beneficiary_id,
      action,
      details: details ? JSON.stringify(details) : null,
      performed_by,
      performed_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getAuditLogs = async (beneficiaryId, { page = 1, pageSize = 50 } = {}) => {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await db
    .from('beneficiary_audit_logs')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('performed_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return data || [];
};

export const getRecentAuditLogs = async (limit = 50) => {
  const { data, error } = await db
    .from('beneficiary_audit_logs')
    .select('*, beneficiaries(beneficiary_code, full_name)')
    .order('performed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
};
