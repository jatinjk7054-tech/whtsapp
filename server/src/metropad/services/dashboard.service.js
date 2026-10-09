import * as MetroLineModel from '../models/metroLine.model.js'
import * as StationModel from '../models/station.model.js'
import * as MachineModel from '../models/machine.model.js'
import * as RefillModel from '../models/refill.model.js'
import { requireDb, normalizeError } from '../config/supabase.js'

const machineFilter = (b, filters = {}) => {
  let q = b
  if (filters.lineId) q = q.eq('line_id', filters.lineId)
  if (filters.stationId) q = q.eq('station_id', filters.stationId)
  if (filters.status) q = q.eq('status', filters.status)
  return q
}

const countMachines = async (extra, filters = {}) => {
  let q = machineFilter(requireDb().from('machines').select('id', { count: 'exact', head: true }), filters)
  q = extra(q)
  const { count, error } = await q
  if (error) throw normalizeError(error)
  return count
}

export const getStats = async (filters = {}) => {
  let totalMetroLines = 0
  let totalStations = 0

  if (filters.stationId) {
    const { data: station, error } = await requireDb()
      .from('stations')
      .select('line_id')
      .eq('id', filters.stationId)
      .maybeSingle()
    if (error) throw normalizeError(error)
    totalMetroLines = station ? 1 : 0
    totalStations = station ? 1 : 0
  } else if (filters.lineId) {
    const { count: lc, error: le } = await requireDb()
      .from('metro_lines')
      .select('id', { count: 'exact', head: true })
      .eq('id', filters.lineId)
    if (le) throw normalizeError(le)
    totalMetroLines = lc
    const { count: sc, error: se } = await requireDb()
      .from('stations')
      .select('id', { count: 'exact', head: true })
      .eq('line_id', filters.lineId)
    if (se) throw normalizeError(se)
    totalStations = sc
  } else {
    const [lv, sv] = await Promise.all([
      requireDb().from('metro_lines').select('id', { count: 'exact', head: true }),
      requireDb().from('stations').select('id', { count: 'exact', head: true }),
    ])
    if (lv.error) throw normalizeError(lv.error)
    if (sv.error) throw normalizeError(sv.error)
    totalMetroLines = lv.count
    totalStations = sv.count
  }

  const [totalMachines, activeMachines, inactiveMachines, maintenanceMachines] = await Promise.all([
    countMachines((q) => q, filters),
    countMachines((q) => q.eq('status', 'ACTIVE'), { ...filters, status: undefined }),
    countMachines((q) => q.eq('status', 'INACTIVE'), { ...filters, status: undefined }),
    countMachines((q) => q.eq('status', 'MAINTENANCE'), { ...filters, status: undefined }),
  ])

  const activeQuery = machineFilter(
    requireDb().from('machines').select('id, current_stock, low_stock_threshold'),
    { ...filters, status: undefined }
  ).eq('status', 'ACTIVE')
  const { data: activeList, error: actErr } = await activeQuery
  if (actErr) throw normalizeError(actErr)
  const lowStockMachines = activeList.filter(
    (m) => Number(m.current_stock) <= Number(m.low_stock_threshold)
  ).length

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10)

  let refillMachineIds = null
  if (filters.lineId || filters.stationId) {
    const getIds = machineFilter(requireDb().from('machines').select('id'), { ...filters, status: undefined })
    const { data: mData, error } = await getIds
    if (error) throw normalizeError(error)
    refillMachineIds = mData.map((m) => m.id)
  }

  let refillQuery = requireDb().from('refill_records').select('refill_quantity').gte('refill_date', monthStart).lt('refill_date', nextMonth)
  let padsRefilledThisMonth = 0
  if (refillMachineIds === null || refillMachineIds.length > 0) {
    if (refillMachineIds) refillQuery = refillQuery.in('machine_id', refillMachineIds)
    const { data: refillList, error: rErr } = await refillQuery
    if (rErr) throw normalizeError(rErr)
    padsRefilledThisMonth = refillList.reduce((t, r) => t + (Number(r.refill_quantity) || 0), 0)
  }

  return {
    totalMetroLines,
    totalStations,
    totalMachines,
    activeMachines,
    inactiveMachines,
    maintenanceMachines,
    lowStockMachines,
    padsRefilledThisMonth,
    activePercentage: totalMachines > 0 ? Math.round((activeMachines / totalMachines) * 100) : 0,
  }
}

export const getLowStockAlerts = async (filters = {}) => {
  const { data, error } = await machineFilter(
    requireDb().from('machines').select('id, machine_id, location, capacity, current_stock, low_stock_threshold, station_id, line_id'),
    { ...filters, status: undefined }
  ).eq('status', 'ACTIVE')
  if (error) throw normalizeError(error)

  const lowStock = data.filter((m) => Number(m.current_stock) <= Number(m.low_stock_threshold))
  const machines = await MachineModel.enrichRows(lowStock)
  const sorted = machines
    .map((m) => ({ ...m, stock_percentage: m.capacity > 0 ? Number(((Number(m.current_stock) / m.capacity) * 100).toFixed(2)) : null }))
    .sort((a, b) => (a.stock_percentage ?? 0) - (b.stock_percentage ?? 0))

  return { machines: sorted, count: sorted.length }
}

export const getAttentionMachines = async (filters = {}) => {
  let q = machineFilter(requireDb().from('machines').select('id, machine_id, location, status, capacity, current_stock, low_stock_threshold, station_id, line_id'), { ...filters, status: undefined })
  q = q.or('status.in.(INACTIVE,OFFLINE,MAINTENANCE),current_stock.eq.0')
  const { data, error } = await q
  if (error) throw normalizeError(error)

  const machines = await MachineModel.enrichRows(data)
  const enriched = machines.map((m) => ({
    ...m,
    stock_percentage: m.capacity > 0 ? Number(((Number(m.current_stock) / m.capacity) * 100).toFixed(2)) : null,
  }))
  enriched.sort((a, b) => String(a.status).localeCompare(String(b.status)) || String(a.line_name || '').localeCompare(String(b.line_name || '')))

  return { machines: enriched, count: enriched.length }
}

export const getRecentRefills = async (limit = 10) => {
  const refills = await RefillModel.findRecent(limit)
  return { refills }
}

export const getOverview = async (filters = {}) => {
  const [stats, lowStock, attention, refills] = await Promise.all([
    getStats(filters),
    getLowStockAlerts(filters),
    getAttentionMachines(filters),
    getRecentRefills(10),
  ])
  return { stats, lowStock, attention, refills }
}