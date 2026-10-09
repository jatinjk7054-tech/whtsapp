import { requireDb, normalizeError } from '../config/supabase.js'
import { enrichRecordRows } from './recordEnricher.js'

const BASE_SELECT = 'id, machine_id, station_id, report_date, expected_stock, actual_stock, missing_quantity, issue_type, reason, status, reported_by, remark, created_at, resolved_at, resolved_by'

const applyFilters = (query, { machineId, stationId, lineId, status, issueType } = {}) => {
  let q = query
  if (machineId) q = q.eq('machine_id', machineId)
  if (stationId) q = q.eq('station_id', stationId)
  if (status) q = q.eq('status', status)
  if (issueType) q = q.eq('issue_type', issueType)
  return q
}

export const findAll = async ({ machineId, stationId, lineId, status, issueType, page = 1, limit = 20 } = {}) => {
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
    b = applyFilters(b, { machineId, stationId, status, issueType })
    if (machineIds) b = b.in('machine_id', machineIds)
    return b
  }

  if (machineIds !== null && machineIds.length === 0) {
    return { issues: [], meta: { page: p, limit: lim, total: 0, totalPages: 0 } }
  }

  const { count, error: cErr } = await build(requireDb().from('stock_issues')).select('id', { count: 'exact', head: true })
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await build(requireDb().from('stock_issues'))
    .select(BASE_SELECT)
    .order('report_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  const issues = await enrichRecordRows(data)

  return {
    issues,
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
    .from('stock_issues')
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
  reportDate,
  expectedStock,
  actualStock,
  missingQuantity,
  issueType = 'MISSING_PADS',
  reason,
  status = 'OPEN',
  reportedBy,
  remark,
  createdBy,
} = {}) => {
  const { data, error } = await requireDb()
    .from('stock_issues')
    .insert({
      machine_id: machineId,
      station_id: stationId,
      report_date: reportDate,
      expected_stock: expectedStock,
      actual_stock: actualStock,
      missing_quantity: missingQuantity,
      issue_type: issueType,
      reason: reason || null,
      status,
      reported_by: reportedBy,
      remark: remark || null,
      created_by: createdBy || null,
    })
    .select('*')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const update = async (id, { expectedStock, actualStock, missingQuantity, issueType, reason, remark } = {}) => {
  const updates = { updated_at: new Date().toISOString() }
  if (expectedStock !== undefined) updates.expected_stock = expectedStock
  if (actualStock !== undefined) updates.actual_stock = actualStock
  if (missingQuantity !== undefined) updates.missing_quantity = missingQuantity
  if (issueType !== undefined) updates.issue_type = issueType
  if (reason !== undefined) updates.reason = reason
  if (remark !== undefined) updates.remark = remark

  const { data, error } = await requireDb()
    .from('stock_issues')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data || (await findById(id))
}

export const updateStatus = async (id, status, user) => {
  const updates = { status, updated_at: new Date().toISOString() }
  if (status === 'RESOLVED') {
    updates.resolved_at = new Date().toISOString()
    updates.resolved_by = user?.name || null
  }

  const { data, error } = await requireDb()
    .from('stock_issues')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}