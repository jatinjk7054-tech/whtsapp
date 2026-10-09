import { requireDb, normalizeError } from '../config/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import * as MonthlyDataModel from '../models/monthlyData.model.js'
import * as MachineModel from '../models/machine.model.js'
import * as MachineStatusHistoryModel from '../models/machineStatusHistory.model.js'
import * as CashCollectionModel from '../models/cashCollection.model.js'
import * as MaintenanceModel from '../models/maintenance.model.js'
import * as RefillService from './refill.service.js'
import * as AuditService from './audit.service.js'

const MONTHLY_MACHINE_STATUSES = ['WORKING', 'NOT_WORKING', 'MAINTENANCE', 'EMPTY', 'OTHER_ISSUE']
const MONTHLY_ISSUE_TYPES = [
  'NONE',
  'COIN_ACCEPTOR_PROBLEM',
  'MACHINE_NOT_WORKING',
  'DISPENSING_PROBLEM',
  'ELECTRICAL_PROBLEM',
  'STOCK_PROBLEM',
  'OTHER',
]

const ISSUE_LABELS = {
  NONE: 'No issue',
  COIN_ACCEPTOR_PROBLEM: 'Coin acceptor problem',
  MACHINE_NOT_WORKING: 'Machine not working',
  DISPENSING_PROBLEM: 'Dispensing problem',
  ELECTRICAL_PROBLEM: 'Electrical problem',
  STOCK_PROBLEM: 'Stock problem',
  OTHER: 'Other issue',
}

const MACHINE_STATUS_MAP = {
  WORKING: 'ACTIVE',
  NOT_WORKING: 'INACTIVE',
  MAINTENANCE: 'MAINTENANCE',
  EMPTY: 'ACTIVE',
  OTHER_ISSUE: 'INACTIVE',
}

const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))

const monthRange = (year, month) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  return { start, end }
}

const resolveMachine = async (machineId) => {
  if (isUUID(machineId)) {
    return MachineModel.findById(machineId)
  }
  return MachineModel.findByMachineId(machineId)
}

const getMachineIdsInLine = async (lineId) => {
  if (!lineId) return null
  const { data, error } = await requireDb().from('machines').select('id').eq('line_id', lineId)
  if (error) throw normalizeError(error)
  return data.map((m) => m.id)
}

// ================================================================
// GET — monthly_data records (new single entry point table)
// ================================================================

export const getMonthlyRecords = async ({ year, month, lineId, stationId, machineId } = {}) => {
  let startDate
  let endDate
  let yearMonth

  if (year && month) {
    const y = Number(year)
    const m = Number(month)
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new AppError('Invalid year', 400)
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new AppError('Invalid month', 400)
    const r = monthRange(y, m)
    startDate = r.start
    endDate = r.end
    yearMonth = `${y}-${String(m).padStart(2, '0')}`
  }

  const lineMachineIds = await getMachineIdsInLine(lineId)

  try {
    const records = await MonthlyDataModel.findRecords({
      yearMonth,
      lineId,
      stationId,
      machineId,
      startDate,
      endDate,
    })

    let scoped = records
    if (lineMachineIds) {
      const set = new Set(lineMachineIds)
      scoped = records.filter((r) => set.has(r.machine_id))
    }

    return buildMonthlyPayload(scoped, yearMonth)
  } catch (err) {
    if (MonthlyDataModel.isTableMissing(err)) {
      if (startDate && endDate) {
        const fallback = await buildFallbackFromTransactions({ startDate, endDate, lineId, stationId, machineId, lineMachineIds })
        return buildMonthlyPayload(fallback, yearMonth)
      }
      return buildMonthlyPayload([], yearMonth)
    }
    throw err
  }
}

const buildFallbackFromTransactions = async ({ startDate, endDate, lineId, stationId, machineId, lineMachineIds }) => {
  const db = requireDb()

  let machQ = db.from('machines').select('id, machine_id, station_id, line_id, status, capacity, current_stock')
  if (lineId) machQ = machQ.eq('line_id', lineId)
  if (stationId) machQ = machQ.eq('station_id', stationId)
  if (machineId) machQ = machQ.eq('id', machineId)
  if (lineMachineIds) machQ = machQ.in('id', lineMachineIds)
  const { data: machines, error: machErr } = await machQ
  if (machErr) return []

  const machineIds = machines.map((m) => m.id)
  const stationIds = [...new Set(machines.map((m) => m.station_id))]
  const lineIds = [...new Set(machines.map((m) => m.line_id))]

  if (!machineIds.length) return []

  const [stationsRes, linesRes, cashRes, refillsRes, issuesRes, maintRes] = await Promise.all([
    stationIds.length ? db.from('stations').select('id, station_code, name, line_id').in('id', stationIds) : { data: [], error: null },
    lineIds.length ? db.from('metro_lines').select('id, name, code').in('id', lineIds) : { data: [], error: null },
    db.from('cash_collections').select('station_id, record_date, cash_collected, remark').in('station_id', stationIds).gte('record_date', startDate).lt('record_date', endDate),
    db.from('refill_records').select('machine_id, station_id, refill_date, refill_quantity, remark').in('machine_id', machineIds).gte('refill_date', startDate).lt('refill_date', endDate),
    db.from('stock_issues').select('machine_id, issue_type, report_date').in('machine_id', machineIds).gte('report_date', startDate).lt('report_date', endDate),
    db.from('maintenance_records').select('machine_id, reported_date, status').in('machine_id', machineIds).gte('reported_date', startDate).lt('reported_date', endDate),
  ])

  const stationMap = Object.fromEntries((stationsRes.data || []).map((s) => [s.id, s]))
  const lineMap = Object.fromEntries((linesRes.data || []).map((l) => [l.id, l]))
  const machineMap = Object.fromEntries(machines.map((m) => [m.id, m]))

  const STATUS_MAP = { ACTIVE: 'WORKING', INACTIVE: 'NOT_WORKING', MAINTENANCE: 'MAINTENANCE' }
  const ISSUE_MAP = { COIN_ACCEPTOR_PROBLEM: 'COIN_ACCEPTOR_PROBLEM', MACHINE_NOT_WORKING: 'MACHINE_NOT_WORKING', DISPENSING_PROBLEM: 'DISPENSING_PROBLEM', ELECTRICAL_PROBLEM: 'ELECTRICAL_PROBLEM', STOCK_PROBLEM: 'STOCK_PROBLEM', OTHER: 'OTHER' }
  const ISSUE_NONE = 'NONE'

  const cashByStationDate = {}
  for (const c of cashRes.data || []) {
    const key = `${c.station_id}_${c.record_date}`
    cashByStationDate[key] = (cashByStationDate[key] || 0) + (Number(c.cash_collected) || 0)
  }

  const padsByMachineDate = {}
  for (const r of refillsRes.data || []) {
    const key = `${r.machine_id}_${r.refill_date}`
    padsByMachineDate[key] = (padsByMachineDate[key] || 0) + (Number(r.refill_quantity) || 0)
  }

  const issuesByMachineDate = {}
  for (const i of issuesRes.data || []) {
    const key = `${i.machine_id}_${i.report_date}`
    issuesByMachineDate[key] = i.issue_type || ISSUE_NONE
  }

  const maintByMachineDate = {}
  for (const m of maintRes.data || []) {
    const key = `${m.machine_id}_${m.reported_date}`
    maintByMachineDate[key] = 'MAINTENANCE'
  }

  const allDates = new Set()
  for (let d = new Date(startDate); d < new Date(endDate); d.setDate(d.getDate() + 1)) {
    allDates.add(d.toISOString().slice(0, 10))
  }
  for (const k of Object.keys(cashByStationDate)) allDates.add(k.split('_')[1])

  const records = []
  const seen = new Set()

  for (const mach of machines || []) {
    const st = stationMap[mach.station_id] || {}
    const ln = lineMap[mach.line_id] || {}
    for (const date of allDates) {
      const cash = cashByStationDate[`${mach.station_id}_${date}`] || 0
      const pads = padsByMachineDate[`${mach.id}_${date}`] || 0
      const issueType = issuesByMachineDate[`${mach.id}_${date}`] || ISSUE_NONE
      const maintStatus = maintByMachineDate[`${mach.id}_${date}`] || null
      const mStatus = maintStatus || STATUS_MAP[mach.status] || 'WORKING'

      if (cash > 0 || pads > 0 || issueType !== ISSUE_NONE || maintStatus) {
        const key = `${mach.id}_${date}`
        if (seen.has(key)) continue
        seen.add(key)

        records.push({
          id: mach.id,
          record_date: date,
          year_month: date.slice(0, 7),
          line_id: mach.line_id,
          line_name: ln.name || null,
          line_code: ln.code || null,
          station_id: mach.station_id,
          station_code: st.station_code || null,
          station_name: st.name || null,
          machine_id: mach.id,
          machine_code: mach.machine_id || null,
          cash_collected: cash,
          pads_refilled: pads,
          machine_status: mStatus,
          issue_type: issueType,
          notes: null,
          next_action: null,
        })
      }
    }
  }

  return records
}

const buildMonthlyPayload = (records, yearMonth = null) => {
  const summary = {
    totalRecords: records.length,
    totalCashCollected: records.reduce((t, r) => t + (Number(r.cash_collected) || 0), 0),
    totalPadsRefilled: records.reduce((t, r) => t + (Number(r.pads_refilled) || 0), 0),
    machineStatusCounts: {},
    issueTypes: {},
  }

  const stationMap = new Map()
  const machineMap = new Map()

  for (const r of records) {
    summary.machineStatusCounts[r.machine_status] = (summary.machineStatusCounts[r.machine_status] || 0) + 1
    if (r.issue_type && r.issue_type !== 'NONE') {
      summary.issueTypes[r.issue_type] = (summary.issueTypes[r.issue_type] || 0) + 1
    }

    const skey = r.station_id
    if (!stationMap.has(skey)) {
      stationMap.set(skey, {
        station_id: skey,
        station_code: r.station_code,
        station_name: r.station_name,
        line_id: r.line_id,
        line_name: r.line_name,
        line_color: r.line_color,
        records: 0,
        cash_collected: 0,
        pads_refilled: 0,
        issues: 0,
      })
    }
    const s = stationMap.get(skey)
    s.records += 1
    s.cash_collected += Number(r.cash_collected) || 0
    s.pads_refilled += Number(r.pads_refilled) || 0
    if (r.issue_type && r.issue_type !== 'NONE') s.issues += 1

    const mkey = r.machine_id
    if (!machineMap.has(mkey)) {
      machineMap.set(mkey, {
        machine_id: mkey,
        machine_code: r.machine_code,
        station_id: r.station_id,
        station_code: r.station_code,
        station_name: r.station_name,
        line_id: r.line_id,
        line_name: r.line_name,
        line_color: r.line_color,
        records: 0,
        cash_collected: 0,
        pads_refilled: 0,
        issues: 0,
      })
    }
    const mm = machineMap.get(mkey)
    mm.records += 1
    mm.cash_collected += Number(r.cash_collected) || 0
    mm.pads_refilled += Number(r.pads_refilled) || 0
    if (r.issue_type && r.issue_type !== 'NONE') mm.issues += 1
  }

  return {
    yearMonth,
    summary,
    rows: records,
    stationWise: [...stationMap.values()].sort(
      (a, b) =>
        String(a.line_name || '').localeCompare(String(b.line_name || '')) ||
        String(a.station_name || '').localeCompare(String(b.station_name || ''))
    ),
    machineWise: [...machineMap.values()].sort(
      (a, b) =>
        String(a.line_name || '').localeCompare(String(b.line_name || '')) ||
        String(a.station_name || '').localeCompare(String(b.station_name || '')) ||
        String(a.machine_code || '').localeCompare(String(b.machine_code || ''))
    ),
  }
}

// ================================================================
// POST — create a monthly_data record + cascade into other modules
// ================================================================

export const createMonthlyRecord = async (data, user) => {
  const {
    machineId,
    recordDate,
    cashCollected,
    padsRefilled,
    machineStatus = 'WORKING',
    issueType = 'NONE',
    notes,
    nextAction,
  } = data

  if (!machineId) throw new AppError('machineId is required', 400)
  if (!recordDate) throw new AppError('recordDate is required', 400)

  if (!MONTHLY_MACHINE_STATUSES.includes(machineStatus)) {
    throw new AppError(`Invalid machineStatus: ${machineStatus}`, 400)
  }
  if (!MONTHLY_ISSUE_TYPES.includes(issueType)) {
    throw new AppError(`Invalid issueType: ${issueType}`, 400)
  }

  const cash = Number(cashCollected ?? 0)
  if (isNaN(cash) || cash < 0) throw new AppError('cashCollected must be a non-negative number', 400)

  const pads = Number(padsRefilled ?? 0)
  if (!Number.isInteger(pads) || pads < 0) throw new AppError('padsRefilled must be a non-negative integer', 400)

  const recordDateStr = String(recordDate).slice(0, 10)
  const yearMonth = recordDateStr.slice(0, 7)

  const machine = await resolveMachine(machineId)
  if (!machine) throw new AppError('Machine not found', 404)

  // 1. Upsert monthly_data row (one entry per machine per date)
  const record = await MonthlyDataModel.insert({
    machine_id: machine.id,
    station_id: machine.station_id,
    line_id: machine.line_id,
    record_date: recordDateStr,
    year_month: yearMonth,
    cash_collected: cash,
    pads_refilled: pads,
    machine_status: machineStatus,
    issue_type: issueType,
    notes: notes || null,
    next_action: nextAction || null,
    created_by: user?.id || null,
  })

  // 2. Cascade — machine status
  const targetStatus = MACHINE_STATUS_MAP[machineStatus] || machine.status
  let machineStatusChanged = false
  if (targetStatus && targetStatus !== machine.status) {
    await MachineModel.updateStatus(machine.id, targetStatus)
    await MachineStatusHistoryModel.create({
      machineId: machine.id,
      previousStatus: machine.status,
      newStatus: targetStatus,
      changedBy: user?.id || null,
      reason: `Monthly data entry ${recordDateStr} (${machineStatus})`,
    })
    machineStatusChanged = true
  }

  // 3. Cascade — pads refilled -> refill record (also updates machine current stock)
  let refill = null
  let refillError = null
  if (pads > 0) {
    try {
      const result = await RefillService.recordRefill(
        {
          machineId: machine.id,
          stationId: machine.station_id,
          refillQuantity: pads,
          refillDate: recordDateStr,
          remark: notes || `Monthly data entry ${recordDateStr}`,
          refilledBy: user?.name || null,
        },
        user
      )
      refill = result.refill
    } catch (err) {
      refillError = err
    }
  }

  // 4. Cascade — cash collected -> cash_collections (per station per date)
  let cashCollection = null
  if (cash > 0) {
    cashCollection = await CashCollectionModel.insert({
      station_id: machine.station_id,
      record_date: recordDateStr,
      cash_collected: cash,
      remark: notes || `Monthly data entry ${recordDateStr}`,
      created_by: user?.id || null,
    })
  }

  // 5. Cascade — non-NONE issue -> maintenance record (OPEN)
  let maintenance = null
  if (issueType !== 'NONE') {
    maintenance = await MaintenanceModel.create({
      machineId: machine.id,
      stationId: machine.station_id,
      problem: `${ISSUE_LABELS[issueType]}${notes ? ` — ${notes}` : ''}`,
      reportedDate: recordDateStr,
      priority: 'MEDIUM',
      status: 'OPEN',
      remark: nextAction || null,
      createdBy: user?.id,
    })
  }

  await AuditService.logAction(user, 'CREATE', 'MONTHLY_DATA', record.id, null, {
    ...record,
    machine_status_changed: machineStatusChanged,
    refill_created: !!refill,
    cash_upserted: !!cashCollection,
    maintenance_created: !!maintenance,
  })

  return {
    record,
    cascade: {
      machineStatusChanged,
      refill: refill
        ? { id: refill.id, created: true }
        : { created: false, error: refillError ? refillError.message : null },
      cashCollection: cashCollection ? { id: cashCollection.id, created: true } : { created: false },
      maintenance: maintenance ? { id: maintenance.id, created: true } : { created: false },
    },
  }
}

// ================================================================
// Legacy aggregate (kept for backward compatibility)
// ================================================================

export const getMonthlyData = async ({ year, month, lineId, stationId, machineId }) => {
  const y = Number(year)
  const m = Number(month)

  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new AppError('Invalid year', 400)
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new AppError('Invalid month', 400)
  }

  const { start, end } = monthRange(y, m)
  const machineIds = await getMachineIds({ lineId, stationId, machineId })

  if (!machineIds.length) {
    return buildEmptyAggregate(y, m, start, end)
  }

  const stationIds = await getStationIds({ lineId, stationId, machineId })

  const [totalMachines, activeMachines, inactiveMachines, maintenanceCases, refills, issues, totalCashCollected] =
    await Promise.all([
      countWithMachineIds(null, machineIds),
      countWithMachineIds('ACTIVE', machineIds),
      countWithMachineIds('INACTIVE', machineIds),
      countRecordsInRange('maintenance_records', 'reported_date', start, end, machineIds),
      sumColsInRange('refill_records', 'refill_date', ['refill_quantity'], start, end, machineIds),
      sumColsInRange('stock_issues', 'report_date', ['missing_quantity'], start, end, machineIds),
      sumCashCollectedInRange(stationIds, start, end),
    ])

  const { data: stockRows, error: sErr } = await requireDb()
    .from('machines')
    .select('current_stock, low_stock_threshold')
    .in('id', machineIds)
  if (sErr) throw normalizeError(sErr)

  const averageStockLevel = stockRows.length
    ? Number((stockRows.reduce((t, r) => t + Number(r.current_stock), 0) / stockRows.length).toFixed(2))
    : 0
  const lowStockMachines = stockRows.filter(
    (r) => Number(r.current_stock) <= Number(r.low_stock_threshold)
  ).length

  return {
    year: y,
    month: m,
    startDate: start,
    endDate: end,
    totalMachines,
    activeMachines,
    inactiveMachines,
    maintenanceCases,
    totalRefills: refills.count,
    totalPadsRefilled: refills.refill_quantity,
    totalCashCollected,
    missingPads: issues.missing_quantity,
    issuesCount: issues.count,
    averageStockLevel,
    lowStockMachines,
  }
}

// ================================================================
// Helpers for legacy aggregate
// ================================================================

const buildEmptyAggregate = (y, m, start, end) => ({
  year: y,
  month: m,
  startDate: start,
  endDate: end,
  totalMachines: 0,
  activeMachines: 0,
  inactiveMachines: 0,
  maintenanceCases: 0,
  totalRefills: 0,
  totalPadsRefilled: 0,
  totalCashCollected: 0,
  missingPads: 0,
  issuesCount: 0,
  averageStockLevel: 0,
  lowStockMachines: 0,
})

const getMachineIds = async (filters) => {
  let q = requireDb().from('machines').select('id')
  if (filters.lineId) q = q.eq('line_id', filters.lineId)
  if (filters.stationId) q = q.eq('station_id', filters.stationId)
  if (filters.machineId) q = q.eq('id', filters.machineId)
  const { data, error } = await q
  if (error) throw normalizeError(error)
  return data.map((m) => m.id)
}

const countWithMachineIds = async (status, machineIds) => {
  let q = requireDb().from('machines').select('id', { count: 'exact', head: true })
  if (machineIds.length) q = q.in('id', machineIds)
  if (status) q = q.eq('status', status)
  const { count, error } = await q
  if (error) throw normalizeError(error)
  return count
}

const countRecordsInRange = async (table, dateCol, start, end, machineIds) => {
  const { count, error } = await requireDb()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .in('machine_id', machineIds)
    .gte(dateCol, start)
    .lt(dateCol, end)
  if (error) throw normalizeError(error)
  return count
}

const sumColsInRange = async (table, dateCol, cols, start, end, machineIds) => {
  const { data, error } = await requireDb()
    .from(table)
    .select(cols.join(','))
    .in('machine_id', machineIds)
    .gte(dateCol, start)
    .lt(dateCol, end)
  if (error) throw normalizeError(error)
  const result = { count: data.length }
  for (const c of cols) {
    result[c] = data.reduce((t, r) => t + (Number(r[c]) || 0), 0)
  }
  return result
}

const getStationIds = async (filters) => {
  let q = requireDb().from('machines').select('station_id')
  if (filters.lineId) q = q.eq('line_id', filters.lineId)
  if (filters.stationId) q = q.eq('station_id', filters.stationId)
  if (filters.machineId) q = q.eq('id', filters.machineId)
  const { data, error } = await q
  if (error) throw normalizeError(error)
  return [...new Set(data.map((m) => m.station_id))]
}

const sumCashCollectedInRange = async (stationIds, start, end) => {
  if (!stationIds.length) return 0
  const { data, error } = await requireDb()
    .from('cash_collections')
    .select('cash_collected')
    .in('station_id', stationIds)
    .gte('record_date', start)
    .lt('record_date', end)
  if (error) {
    if (/does not exist/i.test(String(error?.message || '')) || /Could not find the table/i.test(String(error?.message || '')) || /42P01|PGRST205/i.test(String(error?.code || ''))) {
      return 0
    }
    throw normalizeError(error)
  }
  return data.reduce((t, r) => t + (Number(r.cash_collected) || 0), 0)
}