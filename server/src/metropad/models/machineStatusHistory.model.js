import { requireDb, normalizeError } from '../config/supabase.js'

export const create = async ({ machineId, previousStatus, newStatus, changedBy, reason } = {}) => {
  const { data, error } = await requireDb()
    .from('machine_status_history')
    .insert({
      machine_id: machineId,
      previous_status: previousStatus,
      new_status: newStatus,
      changed_by: changedBy || null,
      reason: reason || null,
    })
    .select('*')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const findByMachineId = async (machineId, { page = 1, limit = 20 } = {}) => {
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (p - 1) * lim

  const { count, error: cErr } = await requireDb()
    .from('machine_status_history')
    .select('id', { count: 'exact', head: true })
    .eq('machine_id', machineId)
  if (cErr) throw normalizeError(cErr)

  const base = 'id, machine_id, previous_status, new_status, changed_by, reason, changed_at'
  const { data, error } = await requireDb()
    .from('machine_status_history')
    .select(base)
    .eq('machine_id', machineId)
    .order('changed_at', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  const machineIds = [...new Set(data.map((h) => h.machine_id))]
  const changedByIds = [...new Set(data.map((h) => h.changed_by).filter(Boolean))]

  const [machinesRes, usersRes] = await Promise.all([
    machineIds.length
      ? requireDb().from('machines').select('id, machine_id').in('id', machineIds)
      : Promise.resolve({ data: [] }),
    changedByIds.length
      ? requireDb().from('metropad_users').select('id, name').in('id', changedByIds)
      : Promise.resolve({ data: [] }),
  ])
  if (machinesRes.error) throw normalizeError(machinesRes.error)
  if (usersRes.error) throw normalizeError(usersRes.error)

  const machineMap = Object.fromEntries(machinesRes.data.map((m) => [m.id, m.machine_id]))
  const userMap = Object.fromEntries(usersRes.data.map((u) => [u.id, u.name]))

  const history = data.map((h) => ({
    ...h,
    machine_code: machineMap[h.machine_id] || null,
    changed_by_name: userMap[h.changed_by] || null,
  }))

  return {
    history,
    meta: {
      page: p,
      limit: lim,
      total: count,
      totalPages: Math.ceil(count / lim),
    },
  }
}