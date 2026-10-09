import db from '../config/db.js';
import { canonicalProject } from './bankAuditModel.js';

export const createReceipt = async (data) => {
  const normalized = { ...data };
  if (data.project_id !== undefined) normalized.project_id = canonicalProject(data.project_id);
  const { data: result, error } = await db
    .from('receipts')
    .insert([normalized])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const findReceiptByLogId = async (logId) => {
  const { data, error } = await db
    .from('receipts')
    .select('*')
    .eq('log_id', logId)
    .order('created_at', { ascending: false })
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const getLastReceiptNo = async (projectId) => {
  const { data, error } = await db
    .from('receipts')
    .select('receipt_no')
    .eq('project_id', projectId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.receipt_no || null;
};

export const listAllReceipts = async () => {
  const { data, error } = await db
    .from('receipts')
    .select('*, fro_donor_logs!receipts_log_id_fkey(fro_worker_id, workers!fro_donor_logs_fro_worker_id_fkey(name))')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const listReceiptsByProject = async (projectId, limit = 50) => {
  const { data, error } = await db
    .from('receipts')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
};

export const updateReceiptByLogId = async (logId, data) => {
  const { data: result, error } = await db
    .from('receipts')
    .update(data)
    .eq('log_id', logId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return result;
};
