import db from '../config/db.js';

export async function isEmailProcessed(messageId) {
  const { data, error } = await db
    .from('email_import_log')
    .select('id, status')
    .eq('email_message_id', messageId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function logImport({
  email_message_id, email_subject, email_from, received_at,
  parsed_amount, parsed_payment_id, parsed_transaction_date,
  parsed_source, parsed_sender_name, bank_entry_id, status, error_message, raw_snippet,
  account_id, account_name, seen,
}) {
  const { data, error } = await db
    .from('email_import_log')
    .insert({
      email_message_id,
      email_subject: email_subject || null,
      email_from: email_from || null,
      received_at: received_at || null,
      parsed_amount: parsed_amount || null,
      parsed_payment_id: parsed_payment_id || null,
      parsed_transaction_date: parsed_transaction_date || null,
      parsed_source: parsed_source || null,
      parsed_sender_name: parsed_sender_name || null,
      bank_entry_id: bank_entry_id || null,
      status: status || 'imported',
      seen: seen ?? false,
      error_message: error_message || null,
      raw_snippet: raw_snippet ? raw_snippet.slice(0, 1000) : null,
      account_id: account_id || null,
      account_name: account_name || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getImportLog(filters = {}) {
  const { data, error } = await db
    .from('email_import_log')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    if (error.message?.includes('relation') || error.message?.includes('does not exist')) return [];
    throw error;
  }

  let result = data || [];
  if (filters.status) result = result.filter(r => r.status === filters.status);
  if (filters.account_id) result = result.filter(r => String(r.account_id) === String(filters.account_id));
  if (filters.limit) result = result.slice(0, filters.limit);
  return result;
}

export async function countByStatus() {
  const { data, error } = await db
    .from('email_import_log')
    .select('status');

  if (error) {
    if (error.message?.includes('relation') || error.message?.includes('does not exist')) {
      return { imported: 0, failed: 0, skipped: 0, seen: 0 };
    }
    throw error;
  }

  const counts = { imported: 0, failed: 0, skipped: 0, seen: 0 };
  for (const row of data || []) {
    if (row.status === 'seen') counts.seen++;
    else if (counts[row.status] !== undefined) counts[row.status]++;
  }
  return counts;
}
