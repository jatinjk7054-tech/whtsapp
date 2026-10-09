import db from '../config/db.js';
import { istDateString } from '../utils/ist.js';
import { conversionRate } from '../utils/leads.js';

export const createLead = async (data) => {
  const { data: lead, error } = await db
    .from('leads')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return lead;
};

// ── Ownership ────────────────────────────────────────────────────────────────
// A lead belongs to a recruiter when they are either the assigned recruiter
// (HR sets recruiter_id when handing work over) or the person who entered it
// (the panel records created_by). Both have to be accepted or a recruiter loses
// sight of leads that were assigned to them rather than typed by them.
//
// A third case matters too: older rows and transfers can carry neither id, only
// the *_by_name stamps. Those leads exist and belong to somebody, so a name
// match counts as well -- otherwise the recruiter who really did the work sees
// nothing. Keep this clause in step with leadBelongsTo() in
// backend/src/utils/leads.js and belongsToLead() in client/src/utils/leads.js.
//
// Ids are compared as strings, because that is what they are: leads.recruiter_id,
// leads.created_by and workers.id are all uuid. This used to be Number() on the
// theory that JWT and PostgREST disagreed on type, but recruiters authenticate as
// workers (see authController.js) so the JWT carries a uuid. Number('09a202b7-…')
// is NaN, the id was dropped, normalizeOwnerIds returned [] and getAllLeads took
// its "owner asked for nothing, so show nothing" early return -- every recruiter
// saw an empty panel regardless of what the table held. Ids are normalised to
// trimmed strings, which matches UUIDs, integers and their string forms alike.
const normalizeOwnerIds = (ownerIds) => {
  if (!ownerIds) return null;
  const ids = ownerIds
    .map((id) => (id === null || id === undefined ? '' : String(id).trim()))
    .filter((id) => id !== '');
  return [...new Set(ids)];
};

// `.or()` conditions are comma-separated and paren-balanced, and the ilike value
// treats % and _ as wildcards, so a display name carrying any of them has to be
// flattened or it would corrupt the filter string (or match every lead).
const sanitizeOrValue = (value) =>
  String(value == null ? '' : value).replace(/[,()*%_]/g, ' ').replace(/\s+/g, ' ').trim();

// One top-level OR per query, which is all PostgREST accepts.
const ownerOrFilter = (ownerIds, ownerName) => {
  const parts = ownerIds.map((id) => `recruiter_id.eq.${id},created_by.eq.${id}`);
  const name = sanitizeOrValue(ownerName);
  if (name) {
    parts.push(`created_by_name.ilike.${name}`, `scheduled_by_name.ilike.${name}`);
  }
  return parts.join(',');
};

const escapeIlike = (term) =>
  String(term).replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/\*/g, '');

const searchOrFilter = (term) => {
  const escaped = escapeIlike(term);
  return `name.ilike.*${escaped}*,email.ilike.*${escaped}*,phone.ilike.*${escaped}*`;
};

const matchesSearch = (rows, term) => {
  const needle = String(term).toLowerCase();
  return rows.filter((row) =>
    [row.name, row.email, row.phone].some((value) =>
      String(value ?? '').toLowerCase().includes(needle)
    )
  );
};

// Exported for the controllers and tests so ownership is defined in exactly one
// place: whoever routes decide who "me" is, this decides what "mine" means.
// The name is optional so a caller that only has an id still gets an answer.
export const ownsLead = (lead, ownerIds, ownerName) => {
  const ids = normalizeOwnerIds(Array.isArray(ownerIds) ? ownerIds : [ownerIds]);
  if (!lead) return false;
  // An unset column must not be coerced to '' and then match an owner whose id is
  // the empty string, so a NULL recruiter_id can never look like a match.
  const matches = (value) => {
    if (value === null || value === undefined || value === '') return false;
    return ids ? ids.includes(String(value).trim()) : false;
  };
  if (ids && ids.length > 0 && (matches(lead.recruiter_id) || matches(lead.created_by))) {
    return true;
  }
  const name = sanitizeOrValue(ownerName).toLowerCase();
  if (!name) return false;
  return [lead.created_by_name, lead.scheduled_by_name].some(
    (value) => sanitizeOrValue(value).toLowerCase() === name
  );
};

// Whether a caller-supplied owner scope can identify anybody at all. An owner
// scope with no usable id AND no name cannot be expressed as a filter that would
// only return that person's rows, so it has to be refused rather than widened --
// but it must only be refused on those grounds, not because an id failed to
// parse, which is the failure that emptied the recruiter panel.
const hasUsableOwnerScope = (ownerIds, ownerName) =>
  (ownerIds && ownerIds.length > 0) || Boolean(sanitizeOrValue(ownerName));

export const getAllLeads = async (filters = {}) => {
  const ownerIds = normalizeOwnerIds(filters.ownerIds);
  // Fail closed: a scope that names nobody must not fall through to "no filter",
  // which would hand one caller the whole table. Refused only when there is
  // genuinely nothing to filter by -- see hasUsableOwnerScope.
  if (ownerIds && !hasUsableOwnerScope(ownerIds, filters.ownerName)) return [];

  let query = db
    .from('leads')
    .select('*, workers!leads_recruiter_id_fkey(name, email)')
    .order('created_at', { ascending: false });

  if (ownerIds) query = query.or(ownerOrFilter(ownerIds, filters.ownerName));
  if (filters.recruiter_id) query = query.eq('recruiter_id', filters.recruiter_id);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.source) query = query.eq('source', filters.source);
  if (filters.created_by) query = query.eq('created_by', filters.created_by);

  // Ownership and search are both ORs, and a query can only carry one. Ownership
  // is the security boundary so it stays in SQL, and the search is applied to the
  // already-owned rows here. That only ever narrows the caller's own leads.
  const searchInMemory = Boolean(filters.search) && Boolean(ownerIds);
  if (filters.search && !searchInMemory) query = query.or(searchOrFilter(filters.search));

  const { data, error } = await query;
  if (error) throw error;
  return searchInMemory ? matchesSearch(data || [], filters.search) : data;
};

export const getLeadById = async (id) => {
  const { data, error } = await db
    .from('leads')
    .select('*, workers!leads_recruiter_id_fkey(name, email)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateLead = async (id, updates) => {
  const { data, error } = await db
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, workers!leads_recruiter_id_fkey(name, email)')
    .single();
  if (error) throw error;
  return data;
};

export const deleteLead = async (id) => {
  const { error } = await db
    .from('leads')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Lead deleted successfully' };
};

export const transferLead = async (id, newCreatedBy, newCreatedByName) => {
  const { data, error } = await db
    .from('leads')
    .update({ created_by: newCreatedBy, created_by_name: newCreatedByName, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, workers!leads_recruiter_id_fkey(name, email)')
    .single();
  if (error) throw error;
  return data;
};

export const getLeadsDashboard = async (filters = {}) => {
  const ownerIds = normalizeOwnerIds(filters.ownerIds);

  // Same fail-closed rule as getAllLeads, and the aggregates are computed from
  // exactly these rows, so a recruiter's totals can never include a colleague's
  // leads.
  let data = [];
  if (!ownerIds || hasUsableOwnerScope(ownerIds, filters.ownerName)) {
    let query = db
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false });
    if (ownerIds) query = query.or(ownerOrFilter(ownerIds, filters.ownerName));
    const { data: rows, error } = await query;
    if (error) throw error;
    data = rows || [];
  }

  const total = data.length;
  // Sessions are pinned to Asia/Kolkata, so "today" has to be an IST day here
  // too; toISOString() would label the evening before as the next day.
  const today = istDateString();
  const newToday = data.filter((l) => istDateString(l.created_at ? new Date(l.created_at) : null) === today).length;
  const byStatus = {};
  data.forEach((l) => {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  });
  const conversion = conversionRate(data);

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = istDateString(d);
    last7.push({ date: ds, count: data.filter((l) => istDateString(l.created_at ? new Date(l.created_at) : null) === ds).length });
  }

  return { total, newToday, byStatus, conversionRate: conversion, last7 };
};
