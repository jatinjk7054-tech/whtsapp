import db from '../config/db.js';

function mask(account) {
  if (!account) return account;
  return {
    ...account,
    key_secret: account.key_secret ? '••••••••' : null,
    webhook_secret: account.webhook_secret ? '••••••••' : null,
  };
}

export async function listAccounts() {
  const { data, error } = await db
    .from('razorpay_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(mask);
}

export async function getActiveAccounts() {
  const { data, error } = await db
    .from('razorpay_accounts')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getAccountById(id, { unmask = false } = {}) {
  const { data, error } = await db
    .from('razorpay_accounts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return unmask ? data : mask(data);
}

export async function getDefaultAccount({ unmask = false } = {}) {
  const { data, error } = await db
    .from('razorpay_accounts')
    .select('*')
    .eq('is_default', true)
    .eq('is_active', true)
    .limit(1);
  if (error) throw error;
  const acc = (data || [])[0];
  return acc ? (unmask ? acc : mask(acc)) : null;
}

export async function createAccount({ name, key_id, key_secret, webhook_secret, is_active, is_default }) {
  if (!name || !key_id || !key_secret) {
    throw new Error('name, key_id, key_secret are required');
  }

  const { data, error } = await db
    .from('razorpay_accounts')
    .insert({
      name,
      key_id,
      key_secret,
      webhook_secret: webhook_secret || '',
      is_active: is_active !== false,
      is_default: !!is_default,
    })
    .select()
    .single();
  if (error) throw error;

  if (is_default && data.id) {
    await db
      .from('razorpay_accounts')
      .update({ is_default: false })
      .eq('is_default', true)
      .neq('id', data.id);
  }

  return mask(data);
}

export async function updateAccount(id, updates) {
  const allowed = {};
  if (updates.name !== undefined) allowed.name = updates.name;
  if (updates.key_id !== undefined) allowed.key_id = updates.key_id;
  if (updates.key_secret !== undefined) allowed.key_secret = updates.key_secret;
  if (updates.webhook_secret !== undefined) allowed.webhook_secret = updates.webhook_secret;
  if (updates.is_active !== undefined) allowed.is_active = updates.is_active;
  if (updates.is_default !== undefined) allowed.is_default = updates.is_default;

  if (Object.keys(allowed).length === 0) throw new Error('No fields to update');

  const { data, error } = await db
    .from('razorpay_accounts')
    .update(allowed)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  if (allowed.is_default) {
    await db
      .from('razorpay_accounts')
      .update({ is_default: false })
      .eq('is_default', true)
      .neq('id', id);
  }

  return mask(data);
}

export async function deleteAccount(id) {
  const { error } = await db
    .from('razorpay_accounts')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

export async function updateLastSynced(id) {
  const { error } = await db
    .from('razorpay_accounts')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
