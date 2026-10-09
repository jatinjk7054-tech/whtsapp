import db from '../config/db.js';

export async function logWebhook({
  gateway, event_type, payment_id, order_id, amount,
  gateway_source, sender_name, sender_email, sender_phone,
  raw_payload, bank_entry_id, status, error_message,
  account_id, account_name,
}) {
  const { data, error } = await db
    .from('payment_webhook_log')
    .insert({
      gateway,
      event_type: event_type || null,
      payment_id: payment_id || null,
      order_id: order_id || null,
      amount: amount || null,
      gateway_source: gateway_source || null,
      sender_name: sender_name || null,
      sender_email: sender_email || null,
      sender_phone: sender_phone || null,
      raw_payload: raw_payload || null,
      bank_entry_id: bank_entry_id || null,
      status: status || 'received',
      error_message: error_message || null,
      account_id: account_id || null,
      account_name: account_name || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getWebhookLog(filters = {}) {
  let query = db
    .from('payment_webhook_log')
    .select('*, bank_audit_entries!left(id, amount, bank_audit_sources(name))')
    .order('created_at', { ascending: false });

  if (filters.gateway) query = query.eq('gateway', filters.gateway);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.account_id) query = query.eq('account_id', filters.account_id);
  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function countWebhookByStatus() {
  const { data, error } = await db
    .from('payment_webhook_log')
    .select('gateway, status');
  if (error) throw error;
  const counts = {};
  for (const row of data || []) {
    const key = `${row.gateway}_${row.status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
