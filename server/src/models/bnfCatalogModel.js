import db from '../config/db.js';

// Name-only catalogs for the Beneficiaries app: kits (what the operator is
// handing out today) and organizers (who is running the event). Managed in
// Accounts > Beneficiaries > Programs, consumed as dropdowns on the operator's
// daily assignment screen.

const TABLE = { kits: 'bnf_kits', organizers: 'bnf_organizers' };

export const listCatalog = async (kind) => {
  const { data, error } = await db
    .from(TABLE[kind])
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const createCatalogItem = async (kind, { name, created_by }) => {
  const { data, error } = await db
    .from(TABLE[kind])
    .insert({ name, created_by: created_by || null })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const updateCatalogItem = async (kind, id, updates) => {
  const { data, error } = await db
    .from(TABLE[kind])
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};