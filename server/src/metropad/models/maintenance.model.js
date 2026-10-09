import { requireDb, normalizeError } from '../config/supabase.js'
import { enrichRecordRows } from './recordEnricher.js'

const BASE_SELECT = 'id, machine_id, station_id, problem, priority, technician, status, reported_date, resolved_date, remark, created_at'

const applyFilters = (query, { machineId, stationId, lineId, status, priority } = {}) => {
  let q = query
  if (machineId) q = q.eq('machine_id', machineId)
  if (stationId) q = q.eq('station_id', stationId)
  if (status) q = q.eq('status', status)
  if (priority) q = q.eq('priority', priority)
  return q
}

export const findAll = async ({ machineId, stationId, lineId, status, priority, page = 1, limit = 20 } = {}) => {
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (p - 1) * lim

  let machineIds = null
  if (lineId) {
    const { data, error } = await requireDb().from('machines').select('id').eq('line_id', lineId)
    if (error) throw normalizeError(error)
    machineIds = data.map((m) => m.id)
  }

  const build = (b) => {
    b = applyFilters(b, { machineId, stationId, status, priority })
    if (machineIds) b = b.in('machine_id', machineIds)
    return b
  }

  if (machineIds !== null && machineIds.length === 0) {
    return { maintenance: [], meta: { page: p, limit: lim, total: 0, totalPages: 0 } }
  }

  const { count, error: cErr } = await build(requireDb().from('maintenance_records')).select('id', { count: 'exact', head: true })
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await build(requireDb().from('maintenance_records'))
    .select(BASE_SELECT)
    .order('reported_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  const maintenance = await enrichRecordRows(data)

  return {
    maintenance,
    meta: {
      page: p,
      limit: lim,
      total: count,
      totalPages: Math.ceil(count / lim),
    },
  }
}

export const findById = async (id) => {
  const { data, error } = await requireDb()
    .from('maintenance_records')
    .select(BASE_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw normalizeError(error)
  if (!data) return null
  const rows = await enrichRecordRows([data])
  return rows[0]
}

export const findByMachineId = async (machineId, { page = 1, limit = 20 } = {}) => {
  return findAll({ machineId, page, limit })
}

export const create = async ({
  machineId,
  stationId,
  problem,
  reportedDate,
  priority = 'MEDIUM',
  technician,
  status = 'OPEN',
  remark,
  createdBy,
} = {}) => {
  const { data, error } = await requireDb()
    .from('maintenance_records')
    .insert({
      machine_id: machineId,
      station_id: stationId,
      problem,
      reported_date: reportedDate,
      priority,
      technician: technician || null,
      status,
      remark: remark || null,
      created_by: createdBy || null,
    })
    .select('*')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const update = async (id, { problem, priority, technician, status, reportedDate, resolvedDate, remark } = {}) => {
  const updates = { updated_at: new Date().toISOString() }
  if (problem !== undefined) updates.problem = problem
  if (priority !== undefined) updates.priority = priority
  if (technician !== undefined) updates.technician = technician
  if (status !== undefined) updates.status = status
  if (reportedDate !== undefined) updates.reported_date = reportedDate
  if (remark !== undefined) updates.remark = remark

  if (status === 'RESOLVED') {
    if (resolvedDate) updates.resolved_date = resolvedDate
    else updates.resolved_date = new Date().toISOString().slice(0, 10)
  }

  const { data, error } = await requireDb()
    .from('maintenance_records')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data || (await findById(id))
}

export const countActive = async () => {
  const { count, error } = await requireDb()
    .from('maintenance_records')
    .select('id', { count: 'exact', head: true })
    .not('status', 'in', '("RESOLVED","CLOSED")')
  if (error) throw normalizeError(error)
  return count
}