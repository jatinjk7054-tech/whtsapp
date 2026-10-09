import db from '../config/db.js';

export async function listAgentsForAccount(whatsappAccountId) {
  const { data, error } = await db
    .from('fro_whatsapp_assignments')
    .select('id, fro_worker_id, is_active, created_at, workers!inner(id, name, email, phone)')
    .eq('whatsapp_account_id', whatsappAccountId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function assignAgentToAccount(froWorkerId, whatsappAccountId) {
  const { data, error } = await db
    .from('fro_whatsapp_assignments')
    .insert({ fro_worker_id: froWorkerId, whatsapp_account_id: whatsappAccountId })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('This FRO is already assigned to this account');
    throw error;
  }
  return data;
}

export async function removeAgentFromAccount(froWorkerId, whatsappAccountId) {
  const { error } = await db
    .from('fro_whatsapp_assignments')
    .delete()
    .eq('fro_worker_id', froWorkerId)
    .eq('whatsapp_account_id', whatsappAccountId);
  if (error) throw error;
}

export async function getAccountForFro(froWorkerId) {
  const { data, error } = await db
    .from('fro_whatsapp_assignments')
    .select('whatsapp_account_id, is_active, whatsapp_accounts!inner(id, name, project, phone_number_id)')
    .eq('fro_worker_id', froWorkerId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function searchWorkers(query) {
  const { data, error } = await db
    .from('workers')
    .select('id, name, email, phone')
    .or(`name.ilike.*${query}*,email.ilike.*${query}*,phone.ilike.*${query}*`)
    .limit(20);
  if (error) throw error;
  return data || [];
}
