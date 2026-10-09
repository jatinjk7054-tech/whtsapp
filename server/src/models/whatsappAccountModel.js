import db from '../config/db.js';
import config from '../config/whatsappConfig.js';

export async function listAccounts() {
  const { data, error } = await db
    .from('whatsapp_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;

  if (!data || data.length === 0) {
    const seeded = await ensureDefaultAccount();
    if (seeded) return [seeded];
  }

  return data || [];
}

export async function getActiveAccounts() {
  const { data, error } = await db
    .from('whatsapp_accounts')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getAccountById(id) {
  const { data, error } = await db
    .from('whatsapp_accounts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
}

export async function getAccountByProject(project) {
  const { data, error } = await db
    .from('whatsapp_accounts')
    .select('*')
    .eq('project', project)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getAccountByPhoneNumberId(phoneNumberId) {
  const { data, error } = await db
    .from('whatsapp_accounts')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getDefaultAccount() {
  const { data, error } = await db
    .from('whatsapp_accounts')
    .select('*')
    .eq('is_default', true)
    .eq('is_active', true)
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

export async function createAccount({ name, project, phone_number_id, access_token, waba_id, template_name, template_language, hr_letter_template, hr_warning_template, is_active, is_default }) {
  if (!name || !project || !phone_number_id || !access_token || !waba_id) {
    throw new Error('name, project, phone_number_id, access_token, and waba_id are required');
  }

  if (is_default) {
    await db
      .from('whatsapp_accounts')
      .update({ is_default: false })
      .eq('is_default', true);
  }

  const { data, error } = await db
    .from('whatsapp_accounts')
    .insert({
      name,
      project: project.toLowerCase(),
      phone_number_id,
      access_token,
      waba_id,
      template_name: template_name || null,
      template_language: template_language || 'en',
      hr_letter_template: hr_letter_template || null,
      hr_warning_template: hr_warning_template || null,
      is_active: is_active !== false,
      is_default: !!is_default,
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') throw new Error(`An account for project "${project}" already exists`);
    throw error;
  }
  return data;
}

export async function updateAccount(id, updates) {
  const allowed = {};
  if (updates.name !== undefined) allowed.name = updates.name;
  if (updates.project !== undefined) allowed.project = updates.project.toLowerCase();
  if (updates.phone_number_id !== undefined) allowed.phone_number_id = updates.phone_number_id;
  if (updates.access_token !== undefined) allowed.access_token = updates.access_token;
  if (updates.waba_id !== undefined) allowed.waba_id = updates.waba_id;
  if (updates.template_name !== undefined) allowed.template_name = updates.template_name || null;
  if (updates.template_language !== undefined) allowed.template_language = updates.template_language;
  // Meta-approved templates for HR's outbound-only sends. Used when the
  // recipient is outside the 24-hour window, where a free-form send is refused.
  if (updates.hr_letter_template !== undefined) allowed.hr_letter_template = updates.hr_letter_template || null;
  if (updates.hr_warning_template !== undefined) allowed.hr_warning_template = updates.hr_warning_template || null;
  if (updates.is_active !== undefined) allowed.is_active = updates.is_active;
  if (updates.is_default !== undefined) allowed.is_default = updates.is_default;

  if (Object.keys(allowed).length === 0) throw new Error('No fields to update');

  if (allowed.is_default) {
    await db
      .from('whatsapp_accounts')
      .update({ is_default: false })
      .eq('is_default', true)
      .neq('id', id);
  }

  const { data, error } = await db
    .from('whatsapp_accounts')
    .update(allowed)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (error.code === '23505') throw new Error(`An account for project "${updates.project}" already exists`);
    throw error;
  }
  return data;
}

export async function deleteAccount(id) {
  const { error } = await db
    .from('whatsapp_accounts')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

async function ensureDefaultAccount() {
  if (!config.enabled) return null;

  const { data: existing } = await db
    .from('whatsapp_accounts')
    .select('id')
    .limit(1);
  if (existing && existing.length > 0) return null;

  const newAccount = {
    name: 'Being Sevak',
    project: 'bsct',
    phone_number_id: config.phoneNumberId,
    access_token: config.accessToken,
    waba_id: config.wabaId || '',
    template_name: config.receiptTemplate || 'bsct_receipt_2',
    template_language: config.templateLanguage || 'en',
    is_active: true,
    is_default: true,
  };

  const { data, error } = await db
    .from('whatsapp_accounts')
    .insert(newAccount)
    .select()
    .single();
  if (error) {
    console.error('Auto-seed WhatsApp account failed:', error.message);
    return null;
  }
  console.log('Auto-seeded WhatsApp account: Being Sevak (bsct) from environment variables');
  return data;
}
