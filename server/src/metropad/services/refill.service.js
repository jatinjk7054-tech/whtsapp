import * as RefillModel from '../models/refill.model.js'
import * as MachineModel from '../models/machine.model.js'
import * as StationModel from '../models/station.model.js'
import { requireDb, normalizeError } from '../config/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'
import * as StockService from './stock.service.js'

const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))

export const getAllRefills = async (filters = {}) => {
  return RefillModel.findAll(filters)
}

export const getRefillHistory = async (machineId, pagination = {}) => {
  let machine
  if (isUUID(machineId)) {
    machine = await MachineModel.findById(machineId)
  } else {
    machine = await MachineModel.findByMachineId(machineId)
  }

  if (!machine) {
    throw new AppError('Machine not found', 404)
  }

  return RefillModel.findByMachineId(machine.id, pagination)
}

export const getRecentRefills = async (limit = 10) => {
  const refills = await RefillModel.findRecent(limit)
  return { refills }
}

export const recordRefill = async (data, user) => {
  if (!data.machineId) {
    throw new AppError('machineId is required', 400)
  }
  if (!data.stationId) {
    throw new AppError('stationId is required', 400)
  }

  const refillQuantity = Number(data.refillQuantity)
  if (!Number.isInteger(refillQuantity) || refillQuantity < 0) {
    throw new AppError('refillQuantity must be a non-negative integer', 400)
  }

  const cashCollected = Number(data.cashCollected ?? 0)
  if (isNaN(cashCollected) || cashCollected < 0) {
    throw new AppError('cashCollected must be a non-negative number', 400)
  }

  let machine
  if (isUUID(data.machineId)) {
    machine = await MachineModel.findById(data.machineId)
  } else {
    machine = await MachineModel.findByMachineId(data.machineId)
  }

  if (!machine) {
    throw new AppError('Machine not found', 404)
  }

  let stationId
  if (isUUID(data.stationId)) {
    if (machine.station_id !== data.stationId) {
      throw new AppError('Station does not match the machine', 400)
    }
    stationId = data.stationId
  } else {
    const station = await StationModel.findByCode(data.stationId)
    if (!station) {
      throw new AppError('Station not found', 400)
    }
    if (station.id !== machine.station_id) {
      throw new AppError('Station does not match the machine', 400)
    }
    stationId = station.id
  }

  const previousStock = Number(machine.current_stock)
  const capacity = Number(machine.capacity)
  const newStock = previousStock + refillQuantity

  if (newStock > capacity) {
    throw new AppError(
      `Refill exceeds machine capacity: ${previousStock} + ${refillQuantity} = ${newStock} exceeds capacity ${capacity}`,
      400
    )
  }

  if (refillQuantity > 0) {
    const remainingCentral = await StockService.getRemainingCentralStock()
    if (refillQuantity > remainingCentral) {
      throw new AppError(
        `Insufficient central stock. Only ${remainingCentral} pads are available.`,
        400
      )
    }
  }

  const refillDate = data.refillDate || new Date()
  const recordDate = refillDate instanceof Date
    ? refillDate.toISOString().slice(0, 10)
    : String(refillDate).slice(0, 10)

  const refillResult = await requireDb()
    .from('refill_records')
    .insert({
      machine_id: machine.id,
      station_id: stationId,
      refill_date: refillDate,
      previous_stock: previousStock,
      refill_quantity: refillQuantity,
      new_stock: newStock,
      cash_collected: cashCollected,
      refilled_by: user?.name || data.refilledBy || 'System',
      remark: data.remark || null,
      created_by: user?.id || null,
    })
    .select('*')
    .single()
  if (refillResult.error) throw normalizeError(refillResult.error)
  const refillRecord = refillResult.data

  const machineUpdate = await requireDb()
    .from('machines')
    .update({
      current_stock: newStock,
      last_refill_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', machine.id)
  if (machineUpdate.error) throw normalizeError(machineUpdate.error)

  const yearMonth = recordDate.slice(0, 7)
  try {
    await StockService.setMonthlyRefillStatus(
      { machineId: machine.id, yearMonth, refillStatus: 'COMPLETED', remark: data.remark || null },
      user
    )
  } catch (e) {
    // Status tracking is optional — a refill must never fail because the table is missing.
  }

  const existingStock = await requireDb()
    .from('pad_stock')
    .select('id, opening_stock, refilled_quantity, issues_count, missing_count, closing_stock')
    .eq('machine_id', machine.id)
    .eq('record_date', recordDate)
    .maybeSingle()
  if (existingStock.error) throw normalizeError(existingStock.error)

  const padStock = await requireDb()
    .from('pad_stock')
    .upsert({
      machine_id: machine.id,
      record_date: recordDate,
      opening_stock: existingStock.data ? existingStock.data.opening_stock ?? 0 : previousStock,
      refilled_quantity: existingStock.data ? existingStock.data.refilled_quantity + refillQuantity : refillQuantity,
      issues_count: existingStock.data ? existingStock.data.issues_count || 0 : 0,
      missing_count: existingStock.data ? existingStock.data.missing_count || 0 : 0,
      closing_stock: newStock,
    }, { onConflict: 'machine_id,record_date' })
  if (padStock.error) throw normalizeError(padStock.error)

  const updatedMachine = await MachineModel.findById(machine.id)

  await AuditService.logAction(
    user,
    'CREATE',
    'REFILL',
    refillRecord.id,
    { previous_stock: previousStock },
    refillRecord
  )

  return { refill: refillRecord, machine: updatedMachine }
}

export const updateRefill = async (refillId, data = {}, user) => {
  const { data: existing, error: fErr } = await requireDb()
    .from('refill_records')
    .select('id, machine_id, station_id, refill_date, previous_stock, refill_quantity, new_stock, cash_collected, refilled_by, remark')
    .eq('id', refillId)
    .maybeSingle()
  if (fErr) throw normalizeError(fErr)
  if (!existing) throw new AppError('Refill record not found', 404)

  const machine = await MachineModel.findById(existing.machine_id)
  if (!machine) throw new AppError('Machine not found', 404)

  const oldQty = Number(existing.refill_quantity)
  const newQty = data.refillQuantity !== undefined && data.refillQuantity !== null
    ? Number(data.refillQuantity)
    : oldQty
  if (!Number.isInteger(newQty) || newQty < 0) {
    throw new AppError('refillQuantity must be a non-negative integer', 400)
  }

  const capacity = Number(machine.capacity)
  const previousStock = Number(existing.previous_stock)
  const newStock = previousStock + newQty
  if (newStock > capacity) {
    throw new AppError(
      `Refill exceeds machine capacity: ${previousStock} + ${newQty} = ${newStock} exceeds capacity ${capacity}`,
      400
    )
  }

  if (newQty > oldQty) {
    const remainingCentral = await StockService.getRemainingCentralStock()
    const extra = newQty - oldQty
    if (extra > remainingCentral) {
      throw new AppError(`Insufficient central stock. Only ${remainingCentral} pads are available.`, 400)
    }
  }

  const cashCollected = data.cashCollected !== undefined && data.cashCollected !== null
    ? Number(data.cashCollected)
    : Number(existing.cash_collected || 0)
  if (isNaN(cashCollected) || cashCollected < 0) {
    throw new AppError('cashCollected must be a non-negative number', 400)
  }

  const oldDate = String(existing.refill_date).slice(0, 10)
  const newDate = data.refillDate
    ? String(data.refillDate).slice(0, 10)
    : oldDate

  const refillDate = data.refillDate || existing.refill_date
  const updates = {
    refill_quantity: newQty,
    new_stock: newStock,
    cash_collected: cashCollected,
    refill_date: refillDate,
  }
  if (data.refilledBy !== undefined) updates.refilled_by = data.refilledBy
  if (data.remark !== undefined) updates.remark = data.remark || null

  const { data: updated, error: uErr } = await requireDb()
    .from('refill_records')
    .update(updates)
    .eq('id', existing.id)
    .select('*')
    .single()
  if (uErr) throw normalizeError(uErr)

  const machineStock = Math.max(0, Number(machine.current_stock) - oldQty + newQty)
  const lastRefillRes = await requireDb()
    .from('refill_records')
    .select('refill_date')
    .eq('machine_id', machine.id)
    .order('refill_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastRefillRes.error) throw normalizeError(lastRefillRes.error)

  await requireDb()
    .from('machines')
    .update({
      current_stock: Math.min(machineStock, capacity),
      last_refill_at: lastRefillRes.data ? new Date(`${lastRefillRes.data.refill_date}T00:00:00Z`).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', machine.id)
    .then(async ({ error }) => { if (error) throw normalizeError(error) })

  await refreshPadStock(existing.machine_id, oldDate)
  if (newDate !== oldDate) await refreshPadStock(existing.machine_id, newDate)

  const newYearMonth = newDate.slice(0, 7)
  try {
    await StockService.setMonthlyRefillStatus(
      { machineId: machine.id, yearMonth: newYearMonth, refillStatus: 'COMPLETED', remark: updated.remark || null },
      user
    )
  } catch (e) {
    // Status tracking is optional — an update must never fail because the table is missing.
  }

  await AuditService.logAction(
    user,
    'UPDATE',
    'REFILL',
    updated.id,
    { refill_quantity: oldQty, refill_date: oldDate },
    { refill_quantity: newQty, refill_date: newDate, cash_collected: cashCollected }
  )

  return { refill: updated }
}

export const deleteRefill = async (refillId, user) => {
  const { data: existing, error: fErr } = await requireDb()
    .from('refill_records')
    .select('id, machine_id, station_id, refill_date, refill_quantity, new_stock, remark')
    .eq('id', refillId)
    .maybeSingle()
  if (fErr) throw normalizeError(fErr)
  if (!existing) throw new AppError('Refill record not found', 404)

  const machine = await MachineModel.findById(existing.machine_id)
  if (!machine) throw new AppError('Machine not found', 404)

  const qty = Number(existing.refill_quantity)
  const recordDate = String(existing.refill_date).slice(0, 10)

  const { data: deleted, error: dErr } = await requireDb()
    .from('refill_records')
    .delete()
    .eq('id', existing.id)
    .select('*')
    .single()
  if (dErr) throw normalizeError(dErr)

  const lastRefillRes = await requireDb()
    .from('refill_records')
    .select('refill_date')
    .eq('machine_id', machine.id)
    .order('refill_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastRefillRes.error) throw normalizeError(lastRefillRes.error)

  const machineStock = Math.max(0, Number(machine.current_stock) - qty)
  await requireDb()
    .from('machines')
    .update({
      current_stock: machineStock,
      last_refill_at: lastRefillRes.data ? new Date(`${lastRefillRes.data.refill_date}T00:00:00Z`).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', machine.id)
    .then(async ({ error }) => { if (error) throw normalizeError(error) })

  await refreshPadStock(existing.machine_id, recordDate)

  const yearMonth = recordDate.slice(0, 7)
  const ymYear = Number(yearMonth.slice(0, 4))
  const ymMonth = Number(yearMonth.slice(5, 7))
  const nextYear = ymMonth === 12 ? ymYear + 1 : ymYear
  const nextMonth = ymMonth === 12 ? 1 : ymMonth + 1
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const remainingRes = await requireDb()
    .from('refill_records')
    .select('id', { count: 'exact', head: true })
    .eq('machine_id', machine.id)
    .gte('refill_date', `${yearMonth}-01`)
    .lt('refill_date', monthEnd)
  if (remainingRes.error) throw normalizeError(remainingRes.error)

  if ((remainingRes.count || 0) === 0) {
    try {
      await StockService.setMonthlyRefillStatus(
        { machineId: machine.id, yearMonth, refillStatus: 'PENDING', remark: 'Refill deleted' },
        user
      )
    } catch (e) {
      // Optional — ignore if the status table does not exist yet.
    }
  }

  await AuditService.logAction(
    user,
    'DELETE',
    'REFILL',
    deleted.id,
    { refill_quantity: qty, new_stock: existing.new_stock },
    null
  )

  return { deleted }
}

export const saveMonthlyRefill = async (data, user) => {
  const {
    machineId,
    yearMonth,
    refillQuantity,
    refillDate,
    cashCollected,
    refillStatus,
    remark,
  } = data

  if (!machineId) throw new AppError('machineId is required', 400)
  if (!/^\d{4}-\d{2}$/.test(String(yearMonth || ''))) {
    throw new AppError('yearMonth must be in YYYY-MM format', 400)
  }

  const qty = Number(refillQuantity ?? 0)
  if (!Number.isInteger(qty) || qty < 0) {
    throw new AppError('refillQuantity must be a non-negative integer', 400)
  }

  const cash = Number(cashCollected ?? 0)
  if (isNaN(cash) || cash < 0) {
    throw new AppError('cashCollected must be a non-negative number', 400)
  }

  const machine = isUUID(machineId)
    ? await MachineModel.findById(machineId)
    : await MachineModel.findByMachineId(machineId)
  if (!machine) throw new AppError('Machine not found', 404)

  const [y, m] = String(yearMonth).split('-').map(Number)
  const start = `${yearMonth}-01`
  const nextYear = m === 12 ? y + 1 : y
  const nextMonth = m === 12 ? 1 : m + 1
  const monthEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`

  const dateStr = refillDate ? String(refillDate).slice(0, 10) : start
  if (dateStr.slice(0, 7) !== String(yearMonth)) {
    throw new AppError(`refillDate must be within ${yearMonth}`, 400)
  }

  const { data: monthRows, error: rowsErr } = await requireDb()
    .from('refill_records')
    .select('id, refill_date, refill_quantity')
    .eq('machine_id', machine.id)
    .gte('refill_date', start)
    .lt('refill_date', monthEnd)
    .order('refill_date', { ascending: false })
    .limit(25)
  if (rowsErr) throw normalizeError(rowsErr)
  const existing = monthRows?.[0] || null

  if (qty > 0) {
    if (existing) {
      await updateRefill(
        existing.id,
        { refillQuantity: qty, refillDate: dateStr, cashCollected: cash, remark },
        user
      )
    } else {
      await recordRefill(
        {
          machineId: machine.id,
          stationId: machine.station_id,
          refillQuantity: qty,
          refillDate: dateStr,
          cashCollected: cash,
          remark: remark || `Monthly refill ${yearMonth}`,
          refilledBy: user?.name,
        },
        user
      )
    }
  } else if (existing) {
    await deleteRefill(existing.id, user)
  }

  if (qty === 0) {
    try {
      await StockService.setMonthlyRefillStatus(
        {
          machineId: machine.id,
          yearMonth,
          refillStatus: refillStatus === 'UNABLE_TO_REFILL' ? 'UNABLE_TO_REFILL' : 'PENDING',
          remark: remark || null,
        },
        user
      )
    } catch (e) {
      // Optional status tracking — never fail the edit because of it.
    }
  }

  try {
    const { data: cashMonthRows } = await requireDb()
      .from('cash_collections')
      .select('id')
      .eq('station_id', machine.station_id)
      .gte('record_date', start)
      .lt('record_date', monthEnd)
      .limit(100)
    if (cash > 0) {
      if (cashMonthRows?.length) {
        await requireDb()
          .from('cash_collections')
          .delete()
          .in('id', cashMonthRows.map((r) => r.id))
      }
      await requireDb()
        .from('cash_collections')
        .upsert({
          station_id: machine.station_id,
          record_date: dateStr,
          cash_collected: cash,
          remark: remark || `Monthly refill ${yearMonth}`,
          created_by: user?.id || null,
        }, { onConflict: 'station_id,record_date' })
    } else if (cashMonthRows?.length) {
      await requireDb()
        .from('cash_collections')
        .delete()
        .in('id', cashMonthRows.map((r) => r.id))
    }
  } catch (err) {
    const msg = String(err?.message || '')
    if (!/does not exist/i.test(msg) && !/Could not find the table/i.test(msg) && !/42P01|PGRST205/i.test(String(err?.code || ''))) {
      throw normalizeError(err)
    }
  }

  return {
    machineId: machine.id,
    yearMonth,
    refillQuantity: qty,
    cashCollected: cash,
    refillStatus: qty > 0 ? 'COMPLETED' : refillStatus === 'UNABLE_TO_REFILL' ? 'UNABLE_TO_REFILL' : 'PENDING',
  }
}

const refreshPadStock = async (machineId, date) => {
  const { data: refills, error } = await requireDb()
    .from('refill_records')
    .select('refill_quantity')
    .eq('machine_id', machineId)
    .eq('refill_date', date)
  if (error) throw normalizeError(error)

  const qty = refills.reduce((sum, r) => sum + (Number(r.refill_quantity) || 0), 0)

  const { data: existing, error: padErr } = await requireDb()
    .from('pad_stock')
    .select('id, machine_id, record_date, opening_stock')
    .eq('machine_id', machineId)
    .eq('record_date', date)
    .maybeSingle()
  if (padErr) throw normalizeError(padErr)

  if (qty === 0) {
    if (existing) {
      const { error: delErr } = await requireDb()
        .from('pad_stock')
        .delete()
        .eq('id', existing.id)
      if (delErr) throw normalizeError(delErr)
    }
    return
  }

  const opening = Number(existing?.opening_stock) || 0
  const { error: upsertErr } = await requireDb()
    .from('pad_stock')
    .upsert({
      machine_id: machineId,
      record_date: date,
      opening_stock: opening,
      refilled_quantity: qty,
      issues_count: 0,
      missing_count: 0,
      closing_stock: opening + qty,
    }, { onConflict: 'machine_id,record_date' })
  if (upsertErr) throw normalizeError(upsertErr)
}