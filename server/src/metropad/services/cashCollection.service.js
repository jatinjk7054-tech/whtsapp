import { requireDb, normalizeError } from '../config/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import * as CashCollectionModel from '../models/cashCollection.model.js'
import * as AuditService from './audit.service.js'

const monthRange = (year, month) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  return { start, end }
}

const getStationIds = async ({ lineId, stationId } = {}) => {
  let q = requireDb().from('stations').select('id')
  if (lineId) q = q.eq('line_id', lineId)
  if (stationId) q = q.eq('id', stationId)
  const { data, error } = await q
  if (error) throw normalizeError(error)
  return data.map((s) => s.id)
}

export const getMonthlyCollections = async ({ year, month, lineId, stationId } = {}) => {
  const y = Number(year)
  const m = Number(month)

  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new AppError('Invalid year', 400)
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new AppError('Invalid month', 400)
  }

  const { start, end } = monthRange(y, m)
  const stationIds = await getStationIds({ lineId, stationId })

  if (!stationIds.length) {
    return { year: y, month: m, rows: [], totalCash: 0, count: 0 }
  }

  const { data: records, error } = await CashCollectionModel.findBetween(stationIds, start, end)
  if (error) {
    if (CashCollectionModel.isTableMissing(error)) {
      return { year: y, month: m, rows: [], totalCash: 0, count: 0 }
    }
    throw normalizeError(error)
  }

  if (!records.length) {
    return { year: y, month: m, rows: [], totalCash: 0, count: 0 }
  }

  const stationIdsWithCash = [...new Set(records.map((r) => r.station_id))]
  const [stationsRes, linesRes] = await Promise.all([
    requireDb().from('stations').select('id, station_code, name, line_id').in('id', stationIdsWithCash),
    requireDb().from('metro_lines').select('id, name, code'),
  ])
  if (stationsRes.error) throw normalizeError(stationsRes.error)
  if (linesRes.error) throw normalizeError(linesRes.error)

  const stationMap = Object.fromEntries(stationsRes.data.map((s) => [s.id, s]))
  const lineMap = Object.fromEntries(linesRes.data.map((l) => [l.id, l]))

  const rows = stationIdsWithCash
    .map((sid) => {
      const s = stationMap[sid] || {}
      const l = lineMap[s.line_id] || {}
      const stationRecords = records.filter((r) => r.station_id === sid)
      const totalCash = stationRecords.reduce((t, r) => t + (Number(r.cash_collected) || 0), 0)
      return {
        station_id: sid,
        station_name: s.name || null,
        station_code: s.station_code || null,
        line_id: s.line_id || null,
        line_name: l.name || null,
        line_code: l.code || null,
        total_cash: totalCash,
        record_count: stationRecords.length,
        last_record_date: stationRecords[0]?.record_date || null,
        records: stationRecords.map((r) => ({
          id: r.id,
          record_date: r.record_date,
          cash_collected: r.cash_collected,
          remark: r.remark || null,
        })),
      }
    })
    .sort((a, b) => String(a.line_name || '').localeCompare(String(b.line_name || '')) || String(a.station_name || '').localeCompare(String(b.station_name || '')))

  const totalCash = rows.reduce((t, r) => t + (Number(r.total_cash) || 0), 0)

  return { year: y, month: m, rows, totalCash, count: rows.length }
}

export const createCashCollection = async (data, user) => {
  if (!data.stationId) throw new AppError('stationId is required', 400)
  if (!data.recordDate) throw new AppError('recordDate is required', 400)

  const cashCollected = Number(data.cashCollected ?? 0)
  if (isNaN(cashCollected) || cashCollected < 0) {
    throw new AppError('cashCollected must be a non-negative number', 400)
  }

  const recordDate = String(data.recordDate).slice(0, 10)

  const { data: station, error: stationErr } = await requireDb()
    .from('stations')
    .select('id, name, station_code, line_id')
    .eq('id', data.stationId)
    .maybeSingle()
  if (stationErr) throw normalizeError(stationErr)
  if (!station) throw new AppError('Station not found', 404)

  const record = await CashCollectionModel.insert({
    station_id: station.id,
    record_date: recordDate,
    cash_collected: cashCollected,
    remark: data.remark || null,
    created_by: user?.id || null,
  })

  await AuditService.logAction(user, 'CREATE', 'CASH_COLLECTION', record.id, null, record)

  return { cashCollection: record, station }
}

export const removeCashCollection = async (id, user) => {
  const existing = await CashCollectionModel.remove(id)
  if (!existing) throw new AppError('Cash collection record not found', 404)

  await AuditService.logAction(user, 'DELETE', 'CASH_COLLECTION', id, existing, null)

  return { id }
}