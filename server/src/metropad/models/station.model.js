import { requireDb, normalizeError } from '../config/supabase.js'
import { withMachineSpec } from '../config/machineSpec.js'
import { purgeMachine } from './machine.model.js'

const STATION_SELECT = 'id, line_id, station_code, name, description, status, created_at, updated_at'
const LINE_SELECT = 'id, name, code, status'

const getLines = async () => {
  const { data, error } = await requireDb().from('metro_lines').select(LINE_SELECT)
  if (error) throw normalizeError(error)
  return data
}

const getMachinesByStation = async (stationIds) => {
  if (!stationIds.length) return []
  const { data, error } = await requireDb()
    .from('machines')
    .select('id, station_id, machine_id, location, machine_type, capacity, current_stock, low_stock_threshold, status, last_refill_at, last_maintenance_at, installation_date')
    .in('station_id', stationIds)
  if (error) throw normalizeError(error)
  return data
}

export const findAll = async ({ search, status, lineId, page = 1, limit = 20 } = {}) => {
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (p - 1) * lim

  const lines = await getLines()
  const lineMap = Object.fromEntries(lines.map((l) => [l.id, l]))

  let matchingLineIds = null
  if (search) {
    const { data: lData, error: lErr } = await requireDb()
      .from('metro_lines')
      .select('id')
      .or(`name.ilike.%${search}%,code.ilike.%${search}%`)
    if (lErr) throw normalizeError(lErr)
    matchingLineIds = lData.map((l) => l.id)
  }

  let countQuery = requireDb().from('stations').select('id', { count: 'exact', head: true })
  let dataQuery = requireDb().from('stations').select(STATION_SELECT)

  if (search) {
    const orParts = [`name.ilike.%${search}%`, `station_code.ilike.%${search}%`]
    if (matchingLineIds.length) orParts.push(`line_id.in.(${matchingLineIds.join(',')})`)
    countQuery = countQuery.or(orParts.join(','))
    dataQuery = dataQuery.or(orParts.join(','))
  }
  if (status) {
    countQuery = countQuery.eq('status', status)
    dataQuery = dataQuery.eq('status', status)
  }
  if (lineId) {
    countQuery = countQuery.eq('line_id', lineId)
    dataQuery = dataQuery.eq('line_id', lineId)
  }

  const { count, error: cErr } = await countQuery
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await dataQuery.order('line_id', { ascending: true }).order('name', { ascending: true }).range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  const machines = await getMachinesByStation((data || []).map((s) => s.id))
  const stationAgg = {}
  for (const m of machines || []) {
    const id = m.station_id
    stationAgg[id] = stationAgg[id] || { machine_count: 0, active_machine_count: 0, total_stock: 0 }
    stationAgg[id].machine_count++
    if (m.status === 'ACTIVE') stationAgg[id].active_machine_count++
    stationAgg[id].total_stock += Number(m.current_stock) || 0
  }

  const stations = data.map((s) => {
    const line = lineMap[s.line_id] || {}
    const agg = stationAgg[s.id] || { machine_count: 0, active_machine_count: 0, total_stock: 0 }
    return {
      ...s,
      line_name: line.name || null,
      line_code: line.code || null,
      machine_count: agg.machine_count,
      active_machine_count: agg.active_machine_count,
      total_stock: agg.total_stock,
    }
  })

  return {
    stations,
    meta: {
      page: p,
      limit: lim,
      total: count,
      totalPages: Math.ceil(count / lim),
    },
  }
}

export const findById = async (id) => {
  const { data: station, error } = await requireDb()
    .from('stations')
    .select(STATION_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw normalizeError(error)
  if (!station) return null

  const lines = await getLines()
  const line = lines.find((l) => l.id === station.line_id) || {}

  const machines = await getMachinesByStation([id])
  const agg = machines.reduce(
    (a, m) => {
      a.machine_count++
      if (m.status === 'ACTIVE') a.active++
      else if (m.status === 'INACTIVE') a.inactive++
      else if (m.status === 'MAINTENANCE') a.maintenance++
      a.total_stock += Number(m.current_stock) || 0
      return a
    },
    { machine_count: 0, active: 0, inactive: 0, maintenance: 0, total_stock: 0 }
  )

  const machineList = machines
    .map((m) => withMachineSpec({
      id: m.id,
      machine_id: m.machine_id,
      location: m.location,
      machine_type: m.machine_type,
      capacity: m.capacity,
      current_stock: m.current_stock,
      low_stock_threshold: m.low_stock_threshold,
      status: m.status,
      last_refill_at: m.last_refill_at,
      last_maintenance_at: m.last_maintenance_at,
      installation_date: m.installation_date,
      stock_percentage:
        m.capacity > 0 ? Number(((Number(m.current_stock) / m.capacity) * 100).toFixed(2)) : null,
    }))
    .sort((a, b) => String(a.machine_id).localeCompare(String(b.machine_id)))

  const machineIds = machines.map((m) => m.id)
  const machineLookup = Object.fromEntries(machines.map((m) => [m.id, m.machine_id]))

  const fetchRecent = async (table, select, orderCol) => {
    if (!machineIds.length) return []
    const { data, error: e } = await requireDb()
      .from(table)
      .select(select)
      .in('machine_id', machineIds)
      .order(orderCol, { ascending: false })
      .order('created_at', { ascending: false })
      .limit(10)
    if (e) throw normalizeError(e)
    return data.map((r) => ({ ...r, machine_code: machineLookup[r.machine_id] || null }))
  }

  const [recent_refills, recent_issues, recent_maintenance] = await Promise.all([
    fetchRecent('refill_records', 'id, machine_id, refill_date, previous_stock, refill_quantity, new_stock, cash_collected, refilled_by, remark, created_at', 'refill_date'),
    fetchRecent('stock_issues', 'id, machine_id, report_date, issue_type, status, missing_quantity, reason, reported_by, created_at', 'report_date'),
    fetchRecent('maintenance_records', 'id, machine_id, problem, priority, status, reported_date, technician, resolved_date, created_at', 'reported_date'),
  ])

  return {
    ...station,
    line_name: line.name || null,
    line_code: line.code || null,
    line_status: line.status || null,
    machine_count: agg.machine_count,
    active_machine_count: agg.active,
    inactive_machine_count: agg.inactive,
    maintenance_machine_count: agg.maintenance,
    total_stock: agg.total_stock,
    machines: machineList,
    recent_refills,
    recent_issues,
    recent_maintenance,
  }
}

export const findByCode = async (stationCode) => {
  const { data, error } = await requireDb()
    .from('stations')
    .select('*')
    .eq('station_code', stationCode)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const create = async ({ lineId, stationCode, name, description, status = 'ACTIVE', createdBy } = {}) => {
  const { data, error } = await requireDb()
    .from('stations')
    .insert({ line_id: lineId, station_code: stationCode, name, description: description || null, status, created_by: createdBy || null })
    .select('*')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const update = async (id, { lineId, stationCode, name, description, status } = {}) => {
  const updates = { updated_at: new Date().toISOString() }
  if (lineId !== undefined) updates.line_id = lineId
  if (stationCode !== undefined) updates.station_code = stationCode
  if (name !== undefined) updates.name = name
  if (description !== undefined) updates.description = description
  if (status !== undefined) updates.status = status

  const { data, error } = await requireDb()
    .from('stations')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data || (await findById(id))
}

export const updateStatus = async (id, status) => {
  const { data, error } = await requireDb()
    .from('stations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

const STATION_CHILD_TABLES = [
  'refill_records',
  'stock_issues',
  'maintenance_records',
  'cash_collections',
  'monthly_data',
]

export const remove = async (id) => {
  const db = requireDb()

  const { data: machines, error: mErr } = await db
    .from('machines')
    .select('id')
    .eq('station_id', id)
  if (mErr) throw normalizeError(mErr)
  for (const m of machines || []) {
    await purgeMachine(m.id)
  }

  for (const table of STATION_CHILD_TABLES) {
    const { error } = await db.from(table).delete().eq('station_id', id)
    if (error) throw normalizeError(error)
  }

  const { error: machErr } = await db.from('machines').delete().eq('station_id', id)
  if (machErr) throw normalizeError(machErr)

  const { data, error } = await db
    .from('stations')
    .delete()
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}