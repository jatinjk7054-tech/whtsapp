import { requireDb, normalizeError } from '../config/supabase.js'
import { enrichRecordRows } from './recordEnricher.js'

const BASE_SELECT = 'id, machine_id, station_id, refill_date, previous_stock, refill_quantity, new_stock, cash_collected, refilled_by, remark, created_at'

const pageRecords = async ({ machineId, stationId, lineId, dateFrom, dateTo, page = 1, limit = 20 } = {}) => {
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
    if (machineId) b = b.eq('machine_id', machineId)
    if (stationId) b = b.eq('station_id', stationId)
    if (machineIds) b = b.in('machine_id', machineIds)
    if (dateFrom) b = b.gte('refill_date', dateFrom)
    if (dateTo) b = b.lte('refill_date', dateTo)
    return b
  }

  if (machineIds !== null && machineIds.length === 0) {
    return { records: [], total: 0, page: p, limit: lim }
  }

  const { count, error: cErr } = await build(requireDb().from('refill_records')).select('id', { count: 'exact', head: true })
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await build(requireDb().from('refill_records'))
    .select(BASE_SELECT)
    .order('refill_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  const rows = await enrichRecordRows(data)
  return { records: rows, total: count, page: p, limit: lim }
}

export const findAll = async (options = {}) => {
  const { records, total, page, limit } = await pageRecords(options)
  return {
    refills: records,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }
}

export const findByMachineId = async (machineId, { page = 1, limit = 20 } = {}) => {
  const { records, total, page: p, limit: lim } = await pageRecords({ machineId, page, limit })
  return {
    refills: records,
    meta: {
      page: p,
      limit: lim,
      total,
      totalPages: Math.ceil(total / lim),
    },
  }
}

export const findRecent = async (limit = 10) => {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10))
  const { data, error } = await requireDb()
    .from('refill_records')
    .select(BASE_SELECT)
    .order('refill_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(safeLimit)
  if (error) throw normalizeError(error)
  return enrichRecordRows(data)
}