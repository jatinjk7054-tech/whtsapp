import db from '../config/db.js';

export async function listAccounts() {
  const { data, error } = await db
    .from('email_import_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) {
    if (error.message?.includes('relation') || error.message?.includes('does not exist')) return [];
    throw error;
  }

  return (data || []).map(a => ({
    ...a,
    app_password: a.app_password ? '••••••••' : null,
  }));
}

export async function getActiveAccounts() {
  const { data, error } = await db
    .from('email_import_accounts')
    .select('*')
    .eq('is_active', true);
  if (error) {
    if (error.message?.includes('relation') || error.message?.includes('does not exist')) return [];
    throw error;
  }
  return data || [];
}

export async function getAccountById(id) {
  const { data, error } = await db
    .from('email_import_accounts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function createAccount({ name, email, app_password, imap_host, imap_port, is_active }) {
  const { data, error } = await db
    .from('email_import_accounts')
    .insert({
      name,
      email,
      app_password,
      imap_host: imap_host || 'imap.gmail.com',
      imap_port: imap_port || 993,
      is_active: is_active !== false,
    })
    .select()
    .single();
  if (error) throw error;
  return { ...data, app_password: '••••••••' };
}

export async function updateAccount(id, updates) {
  const allowed = {};
  if (updates.name !== undefined) allowed.name = updates.name;
  if (updates.email !== undefined) allowed.email = updates.email;
  if (updates.app_password !== undefined) allowed.app_password = updates.app_password;
  if (updates.imap_host !== undefined) allowed.imap_host = updates.imap_host;
  if (updates.imap_port !== undefined) allowed.imap_port = updates.imap_port;
  if (updates.is_active !== undefined) allowed.is_active = updates.is_active;

  if (Object.keys(allowed).length === 0) throw new Error('No fields to update');

  const { data, error } = await db
    .from('email_import_accounts')
    .update(allowed)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return { ...data, app_password: '••••••••' };
}

export async function deleteAccount(id) {
  await db.from('email_import_log').delete().eq('account_id', id);
  const { error } = await db
    .from('email_import_accounts')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

export async function updateLastPolled(id) {
  const { error } = await db
    .from('email_import_accounts')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
