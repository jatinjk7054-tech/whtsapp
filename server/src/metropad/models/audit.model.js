import { requireDb, normalizeError } from '../config/supabase.js'

const SELECT = 'id, user_id, user_name, action, entity, entity_id, old_value, new_value, created_at'

export const createAuditLog = async ({ userId, userName, action, entity, entityId, oldValue, newValue }) => {
  const { error } = await requireDb().from('audit_logs').insert({
    user_id: userId,
    user_name: userName,
    action,
    entity,
    entity_id: entityId,
    old_value: oldValue || null,
    new_value: newValue !== undefined ? JSON.stringify(newValue) : null,
  })
  if (error) throw normalizeError(error)
}

export const getAuditLogs = async ({ entity, entityId, page = 1, limit = 20 }) => {
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (p - 1) * lim

  let query = requireDb().from('audit_logs')
  if (entity) query = query.eq('entity', entity)
  if (entityId) query = query.eq('entity_id', entityId)

  const { count, error: cErr } = await query.select('id', { count: 'exact', head: true })
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await query
    .select(SELECT)
    .order('created_at', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  return {
    logs: data,
    meta: {
      page: p,
      limit: lim,
      total: count,
      totalPages: Math.ceil(count / lim),
    },
  }
}