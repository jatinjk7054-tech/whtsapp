import { requireDb, normalizeError } from '../config/supabase.js'
import { enrichRecordRows } from '../models/recordEnricher.js'
import PDFDocument from 'pdfkit'
import * as XLSX from 'xlsx'
import { AppError } from '../middleware/errorHandler.js'
import * as StockService from './stock.service.js'

const withStockFigures = async (summary, y, m) => {
  try {
    const stockReport = await StockService.getMonthlyStockReport(y, m)
    return {
      ...summary,
      openingCentralStock: stockReport.openingCentral,
      padsDistributed: stockReport.distributedInMonth,
      closingCentralStock: stockReport.closingCentral,
      pricePerPad: stockReport.pricePerPad,
      closingCentralStockValue: stockReport.closingCentralValue,
      openingCentralStockValue: stockReport.openingCentralValue,
      totalMachinePads: stockReport.totalMachinePads,
      totalMachineValue: stockReport.totalMachineValue,
      refillQuantity: stockReport.distributedInMonth,
      machinesRefilled: stockReport.machinesRefilled,
      machinesPending: stockReport.machinesPending,
      lowStockMachines: stockReport.lowStockMachines,
      emptyMachines: stockReport.emptyMachines,
    }
  } catch {
    return summary
  }
}

const escapeCSVValue = (val) => {
  const str = String(val ?? '')
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

const capitalizeHeader = (h) =>
  h.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const buildCSV = (rows) => {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const headerLine = headers.map(capitalizeHeader).join(',')
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCSVValue(row[h])).join(',')
  )
  return [headerLine, ...dataLines].join('\n')
}

const stockPct = (m) =>
  m.capacity > 0 ? Number(((Number(m.current_stock) / m.capacity) * 100).toFixed(2)) : null

const getFilteredMachines = async (filters = {}) => {
  let q = requireDb().from('machines').select('id, machine_id, location, station_id, line_id, status, capacity, current_stock, low_stock_threshold, installation_date, last_refill_at')
  if (filters.lineId) q = q.eq('line_id', filters.lineId)
  if (filters.stationId) q = q.eq('station_id', filters.stationId)
  if (filters.machineId) q = q.eq('id', filters.machineId)
  if (filters.status) q = q.eq('status', filters.status)
  if (filters.search) q = q.or(`machine_id.ilike.%${filters.search}%,location.ilike.%${filters.search}%`)
  const { data, error } = await q
  if (error) throw normalizeError(error)
  return data
}

const enrichMachines = async (machines) => {
  if (!machines.length) return []
  const stationIds = [...new Set(machines.map((m) => m.station_id))]
  const lineIds = [...new Set(machines.map((m) => m.line_id))]
  const [stationsRes, linesRes] = await Promise.all([
    requireDb().from('stations').select('id, name, station_code').in('id', stationIds),
    requireDb().from('metro_lines').select('id, name, code').in('id', lineIds),
  ])
  if (stationsRes.error) throw normalizeError(stationsRes.error)
  if (linesRes.error) throw normalizeError(linesRes.error)
  const sMap = Object.fromEntries(stationsRes.data.map((s) => [s.id, s]))
  const lMap = Object.fromEntries(linesRes.data.map((l) => [l.id, l]))
  return machines.map((m) => {
    const s = sMap[m.station_id] || {}
    const l = lMap[m.line_id] || {}
    return { ...m, station_name: s.name, station_code: s.station_code, line_name: l.name, line_code: l.code }
  })
}

export const getStationReport = async (filters = {}) => {
  const machines = await getFilteredMachines({
    lineId: filters.lineId,
    stationId: filters.stationId,
    machineId: filters.machineId,
    status: filters.status,
  })
  const machinesEnriched = await enrichMachines(machines)

  let stations = null

  if (filters.stationId) {
    const { data, error } = await requireDb()
      .from('stations')
      .select('id, station_code, name, line_id')
      .eq('id', filters.stationId)
    if (error) throw normalizeError(error)
    stations = data
  }

  let searchLineIds = null
  if (filters.search) {
    const { data: lines, error: lErr } = await requireDb()
      .from('metro_lines')
      .select('id')
      .or(`name.ilike.%${filters.search}%,code.ilike.%${filters.search}%`)
    if (lErr) throw normalizeError(lErr)
    searchLineIds = lines.map((l) => l.id)
  }

  if (!stations) {
    let q = requireDb().from('stations').select('id, station_code, name, line_id')
    if (filters.lineId) q = q.eq('line_id', filters.lineId)
    if (filters.search) {
      const orParts = [`name.ilike.%${filters.search}%`, `station_code.ilike.%${filters.search}%`]
      if (searchLineIds.length) orParts.push(`line_id.in.(${searchLineIds.join(',')})`)
      q = q.or(orParts.join(','))
    }
    const { data, error } = await q
    if (error) throw normalizeError(error)
    stations = data
  }

  if (filters.stationId || filters.machineId || filters.status) {
    const allowed = new Set(machinesEnriched.map((m) => m.station_id))
    stations = stations.filter((s) => allowed.has(s.id))
    if (filters.machineId && !machinesEnriched.length) stations = []
  }

  const stationIds = stations.map((s) => s.id)
  const lineIds = [...new Set(stations.map((s) => s.line_id))]

  const [stationsRes, linesRes, refills, issues, maint] = await Promise.all([
    requireDb().from('stations').select('id, station_code, name, line_id'),
    lineIds.length ? requireDb().from('metro_lines').select('id, name, code').in('id', lineIds) : Promise.resolve({ data: [] }),
    stationIds.length ? requireDb().from('refill_records').select('station_id, refill_quantity').in('station_id', stationIds) : Promise.resolve({ data: [] }),
    stationIds.length ? requireDb().from('stock_issues').select('station_id, missing_quantity, status').in('station_id', stationIds) : Promise.resolve({ data: [] }),
    stationIds.length ? requireDb().from('maintenance_records').select('station_id, status').in('station_id', stationIds) : Promise.resolve({ data: [] }),
  ])
  if (stationsRes.error) throw normalizeError(stationsRes.error)
  if (linesRes.error) throw normalizeError(linesRes.error)
  if (refills.error) throw normalizeError(refills.error)
  if (issues.error) throw normalizeError(issues.error)
  if (maint.error) throw normalizeError(maint.error)

  const lineMap = Object.fromEntries(linesRes.data.map((l) => [l.id, l]))

  const machineByStation = {}
  for (const m of machines || []) {
    machineByStation[m.station_id] = machineByStation[m.station_id] || { count: 0, active: 0, inactive: 0, stock: 0 }
    machineByStation[m.station_id].count++
    if (m.status === 'ACTIVE') machineByStation[m.station_id].active++
    else if (['INACTIVE', 'OFFLINE', 'MAINTENANCE'].includes(m.status)) machineByStation[m.station_id].inactive++
    machineByStation[m.station_id].stock += Number(m.current_stock) || 0
  }

  const refillAgg = {}
  for (const r of refills.data || []) {
    refillAgg[r.station_id] = refillAgg[r.station_id] || { count: 0, sum: 0 }
    refillAgg[r.station_id].count++
    refillAgg[r.station_id].sum += Number(r.refill_quantity) || 0
  }

  const issueAgg = {}
  for (const i of issues.data || []) {
    issueAgg[i.station_id] = issueAgg[i.station_id] || { missing: 0, open: 0 }
    issueAgg[i.station_id].missing += Number(i.missing_quantity) || 0
    if (!['RESOLVED', 'CLOSED'].includes(i.status)) issueAgg[i.station_id].open++
  }

  const maintAgg = {}
  for (const r of maint.data || []) {
    if (!['RESOLVED', 'CLOSED'].includes(r.status)) maintAgg[r.station_id] = (maintAgg[r.station_id] || 0) + 1
  }

  const rows = stations.map((s) => {
    const line = lineMap[s.line_id] || {}
    const m = machineByStation[s.id] || { count: 0, active: 0, inactive: 0, stock: 0 }
    const rf = refillAgg[s.id] || { count: 0, sum: 0 }
    const is = issueAgg[s.id] || { missing: 0, open: 0 }
    return {
      station_id: s.id,
      station_code: s.station_code,
      station_name: s.name,
      line_name: line.name,
      line_code: line.code,
      machine_count: m.count,
      active_machine_count: m.active,
      inactive_machine_count: m.inactive,
      total_stock: m.stock,
      total_refills: rf.count,
      total_pads_refilled: rf.sum,
      missing_pads: is.missing,
      open_issues: is.open,
      open_maintenance: maintAgg[s.id] || 0,
    }
  })

  rows.sort((a, b) => String(a.line_name).localeCompare(String(b.line_name)) || String(a.station_name).localeCompare(String(b.station_name)))

  return { type: 'station', filters, rows, generatedAt: new Date().toISOString() }
}

export const getMachineReport = async (filters = {}) => {
  const machines = await getFilteredMachines(filters)
  const rows = await enrichMachines(machines)
  const machineIds = rows.map((r) => r.id)

  const [refillsRes, issuesRes, maintRes] = await Promise.all([
    machineIds.length ? requireDb().from('refill_records').select('machine_id, refill_quantity').in('machine_id', machineIds) : Promise.resolve({ data: [] }),
    machineIds.length ? requireDb().from('stock_issues').select('machine_id, missing_quantity').in('machine_id', machineIds) : Promise.resolve({ data: [] }),
    machineIds.length ? requireDb().from('maintenance_records').select('machine_id').in('machine_id', machineIds) : Promise.resolve({ data: [] }),
  ])
  if (refillsRes.error) throw normalizeError(refillsRes.error)
  if (issuesRes.error) throw normalizeError(issuesRes.error)
  if (maintRes.error) throw normalizeError(maintRes.error)

  const agg = (res, qtyCol) => {
    const map = {}
    for (const r of res.data || []) {
      map[r.machine_id] = map[r.machine_id] || { count: 0, sum: 0 }
      map[r.machine_id].count++
      if (qtyCol) map[r.machine_id].sum += Number(r[qtyCol]) || 0
    }
    return map
  }

  const refills = agg(refillsRes, 'refill_quantity')
  const issues = agg(issuesRes, 'missing_quantity')
  const maint = agg(maintRes, null)

  const out = rows.map((m) => ({
    machine_id_db: m.id,
    machine_id: m.machine_id,
    location: m.location,
    station_name: m.station_name,
    station_code: m.station_code,
    line_name: m.line_name,
    line_code: m.line_code,
    status: m.status,
    capacity: m.capacity,
    current_stock: m.current_stock,
    stock_percentage: stockPct(m),
    low_stock_threshold: m.low_stock_threshold,
    installation_date: m.installation_date,
    refill_count: refills[m.id]?.count || 0,
    total_pads_refilled: refills[m.id]?.sum || 0,
    issue_count: issues[m.id]?.count || 0,
    missing_pads: issues[m.id]?.sum || 0,
    maintenance_count: maint[m.id]?.count || 0,
    last_refill_at: m.last_refill_at,
  }))
  out.sort((a, b) => String(a.line_name).localeCompare(String(b.line_name)) || String(a.station_name).localeCompare(String(b.station_name)) || String(a.machine_id).localeCompare(String(b.machine_id)))

  return {
    type: 'machine',
    filters,
    rows: out.map(({ machine_id_db, ...rest }) => rest),
    generatedAt: new Date().toISOString(),
  }
}

export const getMetroLineReport = async (filters = {}) => {
  let lineQuery = requireDb().from('metro_lines').select('id, code, name, status')
  if (filters.lineId) lineQuery = lineQuery.eq('id', filters.lineId)
  if (filters.status) lineQuery = lineQuery.eq('status', filters.status)
  if (filters.search) lineQuery = lineQuery.or(`name.ilike.%${filters.search}%,code.ilike.%${filters.search}%`)

  const { data: lines, error } = await lineQuery
  if (error) throw normalizeError(error)

  const lineIds = lines.map((l) => l.id)
  if (!lineIds.length) {
    return { type: 'metro-line', filters, rows: [], generatedAt: new Date().toISOString() }
  }

  const { data: lineMachineRows, error: lmrErr } = await requireDb()
    .from('machines')
    .select('id, line_id, status, current_stock')
    .in('line_id', lineIds)
  if (lmrErr) throw normalizeError(lmrErr)
  const machinesRes = { data: lineMachineRows, error: null }
  const lineMachineIds = lineMachineRows.map((m) => m.id)

  const [stationsRes, refills, issues] = await Promise.all([
    requireDb().from('stations').select('line_id').in('line_id', lineIds),
    lineMachineIds.length ? requireDb().from('refill_records').select('machine_id, refill_quantity').in('machine_id', lineMachineIds) : Promise.resolve({ data: [] }),
    lineMachineIds.length ? requireDb().from('stock_issues').select('machine_id, missing_quantity').in('machine_id', lineMachineIds) : Promise.resolve({ data: [] }),
  ])
  if (stationsRes.error) throw normalizeError(stationsRes.error)
  if (refills.error) throw normalizeError(refills.error)
  if (issues.error) throw normalizeError(issues.error)

  const lineMachines = {}
  for (const m of machinesRes.data || []) {
    lineMachines[m.line_id] = lineMachines[m.line_id] || { count: 0, active: 0, inactive: 0, stock: 0 }
    lineMachines[m.line_id].count++
    if (m.status === 'ACTIVE') lineMachines[m.line_id].active++
    else if (['INACTIVE', 'OFFLINE', 'MAINTENANCE'].includes(m.status)) lineMachines[m.line_id].inactive++
    lineMachines[m.line_id].stock += Number(m.current_stock) || 0
  }

  const stationCount = {}
  for (const s of stationsRes.data || []) stationCount[s.line_id] = (stationCount[s.line_id] || 0) + 1

  const refillByLine = {}
  const issueByLine = {}
  const machineLineMap = Object.fromEntries(machinesRes.data.map((m) => [m.id, m.line_id]))
  for (const r of refills.data || []) {
    const lid = machineLineMap[r.machine_id]
    if (!lid) continue
    refillByLine[lid] = refillByLine[lid] || { count: 0, sum: 0 }
    refillByLine[lid].count++
    refillByLine[lid].sum += Number(r.refill_quantity) || 0
  }
  for (const i of issues.data || []) {
    const lid = machineLineMap[i.machine_id]
    if (!lid) continue
    issueByLine[lid] = (issueByLine[lid] || 0) + (Number(i.missing_quantity) || 0)
  }

  const rows = lines.map((l) => {
    const m = lineMachines[l.id] || { count: 0, active: 0, inactive: 0, stock: 0 }
    const rf = refillByLine[l.id] || { count: 0, sum: 0 }
    return {
      line_id: l.id,
      code: l.code,
      name: l.name,
      status: l.status,
      station_count: stationCount[l.id] || 0,
      machine_count: m.count,
      active_machine_count: m.active,
      inactive_machine_count: m.inactive,
      total_stock: m.stock,
      total_refills: rf.count,
      total_pads_refilled: rf.sum,
      missing_pads: issueByLine[l.id] || 0,
    }
  })
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))

  return { type: 'metro-line', filters, rows, generatedAt: new Date().toISOString() }
}

const getMonthlyDataRows = async (filters, start, end) => {
  let q = requireDb().from('monthly_data')

  const build = (b) => {
    if (filters.lineId) b = b.eq('line_id', filters.lineId)
    if (filters.stationId) b = b.eq('station_id', filters.stationId)
    if (filters.machineId) b = b.eq('machine_id', filters.machineId)
    return b
  }

  let data = []
  try {
    const res = await build(q)
      .select(
        `id, record_date, year_month, line_id, station_id, machine_id, cash_collected, pads_refilled, machine_status, issue_type, notes, next_action, metro_lines(line_name, color), stations(station_code, station_name), machines(machine_id)`
      )
      .gte('record_date', start)
      .lt('record_date', end)
    if (res.error) {
      return /does not exist/i.test(String(res.error?.message || '')) || /42P01|PGRST205/i.test(String(res.error?.code || ''))
        ? null
        : Promise.reject(res.error)
    }
    data = res.data || []
  } catch (err) {
    if (/does not exist/i.test(String(err?.message || '')) || /Could not find the table/i.test(String(err?.message || '')) || /42P01|PGRST205/i.test(String(err?.code || ''))) {
      return null
    }
    throw err
  }

  const lineIds = [...new Set(data.map((r) => r.line_id))]
  const stationIds = [...new Set(data.map((r) => r.station_id))]
  const [linesRes, stationsRes] = await Promise.all([
    lineIds.length ? requireDb().from('metro_lines').select('id, name, code').in('id', lineIds) : Promise.resolve({ data: [] }),
    stationIds.length ? requireDb().from('stations').select('id, name, station_code, line_id').in('id', stationIds) : Promise.resolve({ data: [] }),
  ])
  if (linesRes.error) throw normalizeError(linesRes.error)
  if (stationsRes.error) throw normalizeError(stationsRes.error)

  const lineMap = Object.fromEntries(linesRes.data.map((l) => [l.id, l]))
  const stationMap = Object.fromEntries(stationsRes.data.map((s) => [s.id, s]))

  return data.map((r) => {
    const line = lineMap[r.line_id] || {}
    const station = stationMap[r.station_id] || {}
    return {
      record_id: r.id,
      record_date: r.record_date,
      year_month: r.year_month,
      station_id: r.station_id,
      station_code: station.station_code || r.stations?.station_code || null,
      station_name: station.name || r.stations?.station_name || null,
      line_id: r.line_id,
      line_name: line.name || r.metro_lines?.line_name || null,
      line_code: line.code || null,
      machine_id: r.machines?.machine_id || null,
      machine_status: r.machine_status,
      issue_type: r.issue_type,
      cash_collected: r.cash_collected,
      pads_refilled: r.pads_refilled,
      notes: r.notes || null,
      next_action: r.next_action || null,
    }
  })
}

const buildMonthlyDataSummary = (rows) => {
  const statusCounts = {}
  const issueCounts = {}
  let cash = 0
  let pads = 0
  for (const r of rows) {
    cash += Number(r.cash_collected) || 0
    pads += Number(r.pads_refilled) || 0
    statusCounts[r.machine_status] = (statusCounts[r.machine_status] || 0) + 1
    if (r.issue_type && r.issue_type !== 'NONE') {
      issueCounts[r.issue_type] = (issueCounts[r.issue_type] || 0) + 1
    }
  }
  return {
    totalRecords: rows.length,
    totalCashCollected: cash,
    totalPadsRefilled: pads,
    machineStatusCounts: statusCounts,
    issueTypes: issueCounts,
  }
}

export const getMonthlyReport = async (filters = {}) => {
  const y = Number(filters.year)
  const m = Number(filters.month)

  if (!y || !m || !Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new AppError('year and month are required and must be valid integers', 400)
  }

  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`

  const monthlyData = await getMonthlyDataRows(filters, start, end)
  if (monthlyData !== null) {
    const summary = await withStockFigures(buildMonthlyDataSummary(monthlyData), y, m)
    return {
      type: 'monthly',
      filters: { ...filters, year: y, month: m },
      summary,
      rows: monthlyData,
      generatedAt: new Date().toISOString(),
    }
  }

  const machines = await getFilteredMachines({ lineId: filters.lineId, stationId: filters.stationId, machineId: filters.machineId })
  const machineIds = machines.map((m) => m.id)
  const stationIds = [...new Set(machines.map((m) => m.station_id))]

  const emptySummary = () => ({
    totalMachines: 0,
    activeMachines: 0,
    inactiveMachines: 0,
    averageStockLevel: 0,
    lowStockMachines: 0,
    totalRefills: 0,
    totalPadsRefilled: 0,
    totalCashCollected: 0,
    missingPads: 0,
    maintenanceCases: 0,
  })

  if (!machineIds.length) {
    return { type: 'monthly', filters: { ...filters, year: y, month: m }, summary: emptySummary(), rows: [], generatedAt: new Date().toISOString() }
  }

  const [refillsRes, issuesRes, maintRes, cashRes] = await Promise.all([
    requireDb().from('refill_records').select('id, machine_id, station_id, refill_date, refill_quantity, remark').in('machine_id', machineIds).gte('refill_date', start).lt('refill_date', end),
    requireDb().from('stock_issues').select('machine_id, missing_quantity').in('machine_id', machineIds).gte('report_date', start).lt('report_date', end),
    requireDb().from('maintenance_records').select('machine_id').in('machine_id', machineIds).gte('reported_date', start).lt('reported_date', end),
    stationIds.length ? requireDb().from('cash_collections').select('id, station_id, record_date, cash_collected, remark').in('station_id', stationIds).gte('record_date', start).lt('record_date', end) : Promise.resolve({ data: [] }),
  ])
  if (refillsRes.error) throw normalizeError(refillsRes.error)
  if (issuesRes.error) throw normalizeError(issuesRes.error)
  if (maintRes.error) throw normalizeError(maintRes.error)
  if (cashRes?.error) {
    const cMsg = String(cashRes.error?.message || '')
    const cCode = String(cashRes.error?.code || '')
    if (!/does not exist/i.test(cMsg) && !/Could not find the table/i.test(cMsg) && !/42P01/i.test(cCode)) {
      throw normalizeError(cashRes.error)
    }
  }

  const summary = emptySummary()
  summary.totalMachines = machines.length
  summary.activeMachines = machines.filter((mm) => mm.status === 'ACTIVE').length
  summary.inactiveMachines = machines.filter((mm) => ['INACTIVE', 'OFFLINE', 'MAINTENANCE'].includes(mm.status)).length
  summary.averageStockLevel = Number((machines.reduce((t, mm) => t + Number(mm.current_stock), 0) / machines.length).toFixed(2))
  summary.lowStockMachines = machines.filter((mm) => Number(mm.current_stock) <= Number(mm.low_stock_threshold)).length

  summary.totalRefills = refillsRes.data.length
  summary.totalPadsRefilled = refillsRes.data.reduce((t, r) => t + (Number(r.refill_quantity) || 0), 0)
  summary.totalCashCollected = (cashRes?.data || []).reduce((t, r) => t + (Number(r.cash_collected) || 0), 0)
  summary.maintenanceCases = maintRes.data.length
  summary.missingPads = issuesRes.data.reduce((t, i) => t + (Number(i.missing_quantity) || 0), 0)

  const refillStationIds = [...new Set(refillsRes.data.map((r) => r.station_id).concat(cashRes?.data?.map((c) => c.station_id) || []))]
  const stationRowsRes = refillStationIds.length
    ? await requireDb().from('stations').select('id, name, station_code').in('id', refillStationIds)
    : { data: [], error: null }
  if (stationRowsRes.error) throw normalizeError(stationRowsRes.error)
  const stationMap = Object.fromEntries(stationRowsRes.data.map((s) => [s.id, s]))

  const rows = refillsRes.data.map((r) => {
    const s = stationMap[r.station_id] || {}
    return {
      refill_id: r.id,
      refill_date: r.refill_date,
      station_id: r.station_id,
      station_name: s.name || null,
      station_code: s.station_code || null,
      machine_id: r.machine_id,
      refill_quantity: r.refill_quantity,
      remark: r.remark || null,
    }
  })

  for (const c of cashRes?.data || []) {
    const s = stationMap[c.station_id] || {}
    rows.push({
      refill_id: c.id,
      refill_date: c.record_date,
      station_id: c.station_id,
      station_name: s.name || null,
      station_code: s.station_code || null,
      machine_id: null,
      refill_quantity: null,
      remark: c.remark || `Cash collection ${c.cash_collected}`,
    })
  }

  rows.sort((a, b) => String(a.refill_date).localeCompare(String(b.refill_date)) || String(a.station_name || '').localeCompare(String(b.station_name || '')))

  const summaryWithStock = await withStockFigures(summary, y, m)

  return {
    type: 'monthly',
    filters: { ...filters, year: y, month: m },
    summary: summaryWithStock,
    rows,
    generatedAt: new Date().toISOString(),
  }
}

export const getRefillReport = async (filters = {}) => {
  const { machineId, stationId, lineId, dateFrom, dateTo, refilledBy } = filters

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
    if (refilledBy) b = b.ilike('refilled_by', `%${refilledBy}%`)
    return b
  }

  if (machineIds !== null && machineIds.length === 0) {
    return { type: 'refills', filters, rows: [], generatedAt: new Date().toISOString() }
  }

  const { data, error } = await build(
    requireDb().from('refill_records').select('id, machine_id, station_id, refill_date, previous_stock, refill_quantity, new_stock, cash_collected, refilled_by, remark, created_at')
  )
    .order('refill_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw normalizeError(error)

  const enriched = await enrichRecordRows(data)

  const rows = enriched.map((r) => ({
    refill_id: r.id,
    refill_date: r.refill_date,
    line_name: r.line_name,
    line_code: r.line_code,
    station_name: r.station_name,
    station_code: r.station_code,
    machine_code: r.machine_code,
    previous_stock: r.previous_stock,
    refill_quantity: r.refill_quantity,
    new_stock: r.new_stock,
    cash_collected: r.cash_collected,
    refilled_by: r.refilled_by,
    remark: r.remark || '',
    created_at: r.created_at,
  }))

  return { type: 'refills', filters, rows, generatedAt: new Date().toISOString() }
}

const getReportData = async (type, filters) => {
  switch (type) {
    case 'station':
      return getStationReport(filters)
    case 'machine':
      return getMachineReport(filters)
    case 'metro-line':
      return getMetroLineReport(filters)
    case 'monthly':
      return getMonthlyReport(filters)
    case 'refills':
      return getRefillReport(filters)
    default:
      throw new AppError('Invalid report type', 400)
  }
}

export const exportCSV = async (type, filters = {}) => {
  const report = await getReportData(type, filters)
  return buildCSV(report.rows)
}

export const exportExcel = async (type, filters = {}) => {
  const report = await getReportData(type, filters)
  const worksheet = XLSX.utils.json_to_sheet(report.rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Report')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

export const exportPDF = async (type, filters = {}) => {
  const report = await getReportData(type, filters)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(16).text(`MetroPad Care — ${type.toUpperCase()} Report`, { align: 'center' })
    doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' })
    doc.moveDown()

    if (report.summary) {
      doc.fontSize(11).text('Summary', { underline: true })
      doc.fontSize(9)
      for (const [key, val] of Object.entries(report.summary)) {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())
        doc.text(`${label}: ${val}`)
      }
      doc.moveDown()
    }

    const headers = report.rows.length ? Object.keys(report.rows[0]) : []
    doc.fontSize(8)
    doc.text(headers.map((h) => capitalizeHeader(h)).join(' | '))
    doc.moveDown(0.3)

    report.rows.forEach((row) => {
      doc.text(headers.map((h) => String(row[h] ?? '')).join(' | '))
      doc.moveDown(0.2)
    })

    doc.end()
  })
}