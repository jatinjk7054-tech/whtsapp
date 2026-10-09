import db from '../config/db.js';

export const createTemplate = async ({ ngo_id, title, category, html_content, variables, created_by }) => {
  const { data, error } = await db
    .from('letter_templates')
    .insert({ ngo_id, title, category, html_content, variables: variables || [], created_by })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getAllTemplates = async (ngo_id) => {
  let query = db
    .from('letter_templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (ngo_id) query = query.eq('ngo_id', ngo_id);

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getTemplateById = async (id) => {
  const { data, error } = await db
    .from('letter_templates')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateTemplate = async (id, updates) => {
  const { data, error } = await db
    .from('letter_templates')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const deleteTemplate = async (id) => {
  const { error } = await db
    .from('letter_templates')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Template deleted successfully' };
};

export const createGeneratedLetter = async ({ template_id, worker_id, ngo_id, generated_by, filled_html, variables }) => {
  const { data, error } = await db
    .from('generated_letters')
    .insert({ template_id, worker_id, ngo_id, generated_by, filled_html, variables: variables || {} })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getGeneratedLetters = async (ngo_id) => {
  let query = db
    .from('generated_letters')
    .select('*, worker:worker_id(name, email), template:template_id(title, category)')
    .order('created_at', { ascending: false });

  if (ngo_id) query = query.eq('ngo_id', ngo_id);

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getGeneratedLettersByWorkerId = async (workerId) => {
  const { data, error } = await db
    .from('generated_letters')
    .select('*, worker:worker_id(name, email), template:template_id(title, category)')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getGeneratedLetterById = async (id) => {
  const { data, error } = await db
    .from('generated_letters')
    .select('*, worker:worker_id(name, email), template:template_id(title, category)')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};
