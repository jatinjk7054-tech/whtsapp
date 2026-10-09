import db from '../config/db.js';

export const addDocument = async (beneficiaryId, data) => {
  // Only persist columns that actually exist on beneficiary_documents. The
  // mobile app sends file_base64 + mime_type (used for the S3 upload), which
  // are not table columns — leaking them into the INSERT makes Postgres abort
  // with "column does not exist" and the document is silently lost.
  const row = { beneficiary_id: beneficiaryId };
  for (const key of [
    'document_type', 'file_url', 'file_name', 'document_number',
    'verification_status', 'uploaded_by', 'remarks',
  ]) {
    const v = data[key];
    if (v !== undefined && v !== null && v !== '') row[key] = v;
  }
  row.uploaded_at = new Date().toISOString();
  const { data: result, error } = await db
    .from('beneficiary_documents')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getDocuments = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_documents')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const updateDocument = async (id, updates) => {
  const { data, error } = await db
    .from('beneficiary_documents')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const removeDocument = async (id) => {
  const { error } = await db.from('beneficiary_documents').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Document removed' };
};
