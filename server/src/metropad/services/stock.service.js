import { requireDb, normalizeError } from '../config/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import * as MachineModel from '../models/machine.model.js'
import * as AuditService from './audit.service.js'

const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))

const REFILL_STATUSES = ['COMPLETED', 'PENDING', 'UNABLE_TO_REFILL']

const isTableMissing = (err) => {
  const msg = String(err?.message || '')
  const code = String(err?.code || '')
  return (
    /does not exist/i.test(msg) ||
    /Could not find the table/i.test(msg) ||
    /PGRST205|42P01/i.test(code)
  )
}

const SETTINGS_MAP = {
  initial_stock: 'initialStock',
  price_per_pad: 'pricePerPad',
  low_stock_threshold: 'lowStockThreshold',
}

export const getConfig = async () => {
  const config = { initialStock: 10000, pricePerPad: 5, lowStockThreshold: 10 }
  try {
    const { data, error } = await requireDb()
      .from('stock_config')
      .select('setting_key, setting_value')
    if (error) {
      const msg = String(error.message || '')
      const code = String(error.code || '')
      if (/does not exist/i.test(msg) || /Could not find the table/i.test(msg) || /42P01/i.test(code)) {
        return config
      }
      throw normalizeError(error)
    }
    data.forEach(row => {
      const key = SETTINGS_MAP[row.setting_key]
      if (key) config[key] = Number(row.setting_value)
    })
  } catch (e) {
    if (e.isOperational) throw e
  }
  return config
}

export const updateConfig = async (updates, user) => {
  const updatable = {}
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) continue
    const numVal = Number(value)
    if (isNaN(numVal) || numVal < 0) {
      throw new AppError(`${key} must be a non-negative number`, 400)
    }
    const dbKey = Object.entries(SETTINGS_MAP).find(([, v]) => v === key)?.[0]
    if (!dbKey) throw new AppError(`Unknown setting: ${key}`, 400)
    updatable[dbKey] = numVal
  }
  try {
    for (const [dbKey, val] of Object.entries(updatable)) {
      const { error } = await requireDb()
        .from('stock_config')
        .update({ setting_value: val, updated_by: user?.id || null, updated_at: new Date().toISOString() })
        .eq('setting_key', dbKey)
      if (error) {
        const msg = String(error.message || '')
        const code = String(error.code || '')
        if (/does not exist/i.test(msg) || /Could not find the table/i.test(msg) || /42P01/i.test(code)) {
          throw new AppError('Stock config table not found. Run the stock migration SQL first.', 400)
        }
        throw normalizeError(error)
      }
    }
  } catch (e) {
    if (e.isOperational) throw e
    throw new AppError('Stock config table not found. Run the stock migration SQL first.', 400)
  }
  return getConfig()
}

export const getStockSummary = async () => {
  const config = await getConfig()
  const { initialStock, pricePerPad, lowStockThreshold } = config

  const { data: allMachines, error: mErr } = await requireDb()
    .from('machines')
    .select('id, machine_id, station_id, line_id, capacity, current_stock, low_stock_threshold, status, last_refill_at')
  if (mErr) throw normalizeError(mErr)

  const machineIds = allMachines.map(m => m.id)
  let totalDistributed = 0
  if (machineIds.length) {
    const { data: refillSums, error: rErr } = await requireDb()
      .from('refill_records')
      .select('refill_quantity')
    if (rErr) throw normalizeError(rErr)
    totalDistributed = refillSums.reduce((sum, r) => sum + (Number(r.refill_quantity) || 0), 0)
  }

  const remainingCentral = Math.max(0, initialStock - totalDistributed)
  const totalMachinePads = allMachines.reduce((sum, m) => sum + (Number(m.current_stock) || 0), 0)

  const enriched = await enrichMachines(allMachines)
  const stationWise = enriched.map(m => ({
    machine_id: m.machine_id,
    line_name: m.line_name,
    line_code: m.line_code,
    station_name: m.station_name,
    station_code: m.station_code,
    current_stock: Number(m.current_stock) || 0,
    capacity: m.capacity,
    low_stock_threshold: m.low_stock_threshold || lowStockThreshold,
    price_per_pad: pricePerPad,
    stock_value: (Number(m.current_stock) || 0) * pricePerPad,
    stock_status: getStockStatus(m.current_stock, m.low_stock_threshold || lowStockThreshold),
    last_refill_at: m.last_refill_at,
    status: m.status,
  }))

  const lowStockMachines = stationWise.filter(m => m.stock_status === 'LOW')
  const emptyMachines = stationWise.filter(m => m.stock_status === 'EMPTY')
  const pendingRefill = stationWise.filter(m =>
    m.stock_status === 'LOW' || m.stock_status === 'EMPTY'
  )

  return {
    initialStock,
    pricePerPad,
    lowStockThreshold,
    initialStockValue: initialStock * pricePerPad,
    totalDistributed,
    distributedValue: totalDistributed * pricePerPad,
    remainingCentral,
    remainingCentralValue: remainingCentral * pricePerPad,
    totalMachinePads,
    totalMachineValue: totalMachinePads * pricePerPad,
    totalMachines: allMachines.length,
    activeMachines: allMachines.filter(m => m.status === 'ACTIVE').length,
    stationWise,
    lowStockMachines: lowStockMachines.length,
    emptyMachines: emptyMachines.length,
    pendingRefillCount: pendingRefill.length,
    pendingRefill,
  }
}

export const getStationWiseStock = async () => {
  const config = await getConfig()
  const { pricePerPad, lowStockThreshold } = config

  const { data: allMachines, error: mErr } = await requireDb()
    .from('machines')
    .select('id, machine_id, station_id, line_id, capacity, current_stock, low_stock_threshold, status, last_refill_at')
  if (mErr) throw normalizeError(mErr)

  const enriched = await enrichMachines(allMachines)

  return enriched.map(m => ({
    machine_id: m.machine_id,
    line_name: m.line_name,
    line_code: m.line_code,
    station_name: m.station_name,
    station_code: m.station_code,
    current_stock: Number(m.current_stock) || 0,
    capacity: m.capacity,
    low_stock_threshold: m.low_stock_threshold || lowStockThreshold,
    price_per_pad: pricePerPad,
    stock_value: (Number(m.current_stock) || 0) * pricePerPad,
    stock_status: getStockStatus(m.current_stock, m.low_stock_threshold || lowStockThreshold),
    last_refill_at: m.last_refill_at,
    status: m.status,
  }))
}

export const getMonthlyStockReport = async (year, month) => {
  const config = await getConfig()
  const { initialStock, pricePerPad, lowStockThreshold } = config

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const nextMonthDate = new Date(year, month, 1)
  const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}-01`
  const yearMonth = `${year}-${String(month).padStart(2, '0')}`

  const [{ data: prevRefills }, { data: monthRefills }, { data: allMachines }, overrideMap, cashRes] =
    await Promise.all([
      requireDb().from('refill_records').select('refill_quantity').lt('refill_date', monthStart),
      requireDb()
        .from('refill_records')
        .select('machine_id, refill_quantity, refill_date')
        .gte('refill_date', monthStart)
        .lt('refill_date', nextMonth),
      requireDb()
        .from('machines')
        .select('id, machine_id, station_id, line_id, capacity, current_stock, low_stock_threshold, status'),
      getMonthlyRefillOverrides(yearMonth),
      requireDb()
        .from('cash_collections')
        .select('station_id, cash_collected')
        .gte('record_date', monthStart)
        .lt('record_date', nextMonth),
    ])

  let monthCash = []
  if (cashRes?.error) {
    if (/does not exist/i.test(String(cashRes.error?.message || '')) || /Could not find the table/i.test(String(cashRes.error?.message || '')) || /42P01|PGRST205/i.test(String(cashRes.error?.code || ''))) {
      monthCash = []
    } else {
      throw normalizeError(cashRes.error)
    }
  } else {
    monthCash = cashRes?.data || []
  }

  const distributedBefore = prevRefills.reduce((sum, r) => sum + (Number(r.refill_quantity) || 0), 0)
  const openingCentral = Math.max(0, initialStock - distributedBefore)

  const monthByMachine = {}
  let distributedInMonth = 0
  for (const r of monthRefills || []) {
    const qty = Number(r.refill_quantity) || 0
    distributedInMonth += qty
    const entry = monthByMachine[r.machine_id] || { qty: 0, lastDate: null }
    entry.qty += qty
    if (!entry.lastDate || String(r.refill_date) > String(entry.lastDate)) {
      entry.lastDate = String(r.refill_date)
    }
    monthByMachine[r.machine_id] = entry
  }

  const machinesRefilled = Object.keys(monthByMachine).length
  const closingCentral = Math.max(0, openingCentral - distributedInMonth)

  const cashByStation = {}
  let totalCashCollected = 0
  for (const c of monthCash || []) {
    const amt = Number(c.cash_collected) || 0
    totalCashCollected += amt
    cashByStation[c.station_id] = (cashByStation[c.station_id] || 0) + amt
  }

  const enriched = await enrichMachines(allMachines)

  const stationList = enriched
    .map((m) => {
      const ref = monthByMachine[m.id] || { qty: 0, lastDate: null }
      const refill_quantity = ref.qty
      const refill_status =
        refill_quantity > 0
          ? 'COMPLETED'
          : overrideMap[m.id] === 'UNABLE_TO_REFILL'
            ? 'UNABLE_TO_REFILL'
            : 'PENDING'
      return {
        machine_id: m.machine_id,
        machine_uuid: m.id,
        station_id: m.station_id,
        line_name: m.line_name,
        line_code: m.line_code,
        station_name: m.station_name,
        station_code: m.station_code,
        refill_quantity,
        refill_date: ref.lastDate,
        price_per_pad: pricePerPad,
        stock_value: refill_quantity * pricePerPad,
        refill_status,
        cash_collected: cashByStation[m.station_id] || 0,
        current_stock: Number(m.current_stock) || 0,
        capacity: m.capacity,
        machine_status: m.status,
      }
    })
    .sort(
      (a, b) =>
        String(a.line_name || '').localeCompare(String(b.line_name || '')) ||
        String(a.station_name || '').localeCompare(String(b.station_name || '')) ||
        String(a.machine_id || '').localeCompare(String(b.machine_id || ''))
    )

  const completedStations = stationList.filter((r) => r.refill_status === 'COMPLETED').length
  const pendingStations = stationList.filter((r) => r.refill_status === 'PENDING').length
  const unableToRefill = stationList.filter((r) => r.refill_status === 'UNABLE_TO_REFILL').length

  const totalMachines = allMachines.length
  const totalMachinePads = allMachines.reduce((sum, m) => sum + (Number(m.current_stock) || 0), 0)
  const lowCount = allMachines.filter((m) => {
    const threshold = m.low_stock_threshold || lowStockThreshold
    return Number(m.current_stock) > 0 && Number(m.current_stock) <= threshold
  }).length
  const emptyCount = allMachines.filter((m) => Number(m.current_stock) === 0).length
  const pendingCount = lowCount + emptyCount

  const summary = {
    totalInitialStock: initialStock,
    initialStockValue: initialStock * pricePerPad,
    pricePerPad,
    totalStations: totalMachines,
    completedStations,
    pendingStations,
    unableToRefill,
    totalPadsRefilled: distributedInMonth,
    refilledValue: distributedInMonth * pricePerPad,
    totalCashCollected,
    remainingCentralStock: closingCentral,
    remainingCentralValue: closingCentral * pricePerPad,
    openingCentral,
    openingCentralValue: openingCentral * pricePerPad,
  }

  return {
    year,
    month,
    yearMonth,
    openingCentral,
    distributedInMonth,
    closingCentral,
    distributedBefore,
    pricePerPad,
    openingCentralValue: openingCentral * pricePerPad,
    closingCentralValue: closingCentral * pricePerPad,
    distributedMonthValue: distributedInMonth * pricePerPad,
    totalCashCollected,
    totalMachinePads,
    totalMachineValue: totalMachinePads * pricePerPad,
    totalMachines,
    machinesRefilled,
    machinesPending: totalMachines - machinesRefilled,
    lowStockMachines: lowCount,
    emptyMachines: emptyCount,
    pendingRefillCount: pendingCount,
    summary,
    stationList,
  }
}

export const getMonthlyRefillOverrides = async (yearMonth) => {
  try {
    const { data, error } = await requireDb()
      .from('monthly_refill_status')
      .select('machine_id, refill_status')
      .eq('year_month', yearMonth)
    if (error) throw error
    return Object.fromEntries(
      (data || [])
        .filter((r) => r.refill_status === 'UNABLE_TO_REFILL')
        .map((r) => [r.machine_id, r.refill_status])
    )
  } catch (err) {
    if (isTableMissing(err)) return {}
    throw err
  }
}

export const setMonthlyRefillStatus = async ({ machineId, yearMonth, refillStatus, remark }, user) => {
  if (!machineId) throw new AppError('machineId is required', 400)
  if (!/^\d{4}-\d{2}$/.test(String(yearMonth || ''))) {
    throw new AppError('yearMonth must be in YYYY-MM format', 400)
  }
  if (!REFILL_STATUSES.includes(refillStatus)) {
    throw new AppError('refillStatus must be COMPLETED, PENDING or UNABLE_TO_REFILL', 400)
  }

  let machine
  if (isUUID(machineId)) {
    machine = await MachineModel.findById(machineId)
  } else {
    machine = await MachineModel.findByMachineId(machineId)
  }
  if (!machine) throw new AppError('Machine not found', 404)

  try {
    const { data, error } = await requireDb()
      .from('monthly_refill_status')
      .upsert(
        {
          machine_id: machine.id,
          year_month: yearMonth,
          refill_status: refillStatus,
          remark: remark || null,
          created_by: user?.id || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'machine_id,year_month' }
      )
      .select('id, machine_id, year_month, refill_status, remark')
      .single()
    if (error) throw normalizeError(error)

    await AuditService.logAction(
      user,
      'UPDATE',
      'REFILL_STATUS',
      data.id,
      null,
      { machine_id: machine.id, machine_code: machine.machine_id, year_month, refill_status: data.refill_status, remark: data.remark }
    )

    return data
  } catch (err) {
    if (err.isOperational && isTableMissing(err)) {
      throw new AppError(
        'The monthly_refill_status table is missing. Run backend/db/migrate-monthly-refill.sql in the Supabase SQL Editor first.',
        400
      )
    }
    throw err
  }
}

export const getRemainingCentralStock = async () => {
  const config = await getConfig()
  const { initialStock } = config

  const { data: refills, error } = await requireDb()
    .from('refill_records')
    .select('refill_quantity')
  if (error) throw normalizeError(error)

  const totalDistributed = refills.reduce((sum, r) => sum + (Number(r.refill_quantity) || 0), 0)
  return Math.max(0, initialStock - totalDistributed)
}

const enrichMachines = async (machines) => {
  if (!machines.length) return []
  const stationIds = [...new Set(machines.map(m => m.station_id))]
  const lineIds = [...new Set(machines.map(m => m.line_id))]

  const [{ data: stations }, { data: lines }] = await Promise.all([
    stationIds.length
      ? requireDb().from('stations').select('id, name, station_code, status').in('id', stationIds)
      : Promise.resolve({ data: [] }),
    lineIds.length
      ? requireDb().from('metro_lines').select('id, name, code').in('id', lineIds)
      : Promise.resolve({ data: [] }),
  ])

  const sMap = Object.fromEntries(stations.map(s => [s.id, s]))
  const lMap = Object.fromEntries(lines.map(l => [l.id, l]))

  return machines.map(m => ({
    ...m,
    station_name: sMap[m.station_id]?.name || null,
    station_code: sMap[m.station_id]?.station_code || null,
    line_name: lMap[m.line_id]?.name || null,
    line_code: lMap[m.line_id]?.code || null,
  }))
}

function getStockStatus(currentStock, threshold) {
  const stock = Number(currentStock) || 0
  const thr = Number(threshold) || 10
  if (stock === 0) return 'EMPTY'
  if (stock <= thr) return 'LOW'
  return 'GOOD'
}
