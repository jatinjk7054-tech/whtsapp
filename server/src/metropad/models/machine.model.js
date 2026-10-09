import { requireDb, normalizeError } from '../config/supabase.js'
import { withMachineSpec } from '../config/machineSpec.js'

const MACHINE_SELECT = 'id, machine_id, station_id, line_id, location, machine_type, capacity, current_stock, low_stock_threshold, installation_date, status, remark, last_refill_at, last_maintenance_at, created_at, updated_at'

const stockPercentage = (m) =>
  m.capacity > 0 ? Number(((Number(m.current_stock) / m.capacity) * 100).toFixed(2)) : null

export const enrichRows = async (machines) => {
  const stationIds = [...new Set(machines.map((m) => m.station_id))]
  const lineIds = [...new Set(machines.map((m) => m.line_id))]

  const enrichAsync = async () => {
    const [{ data: stations }, { data: lines }] = await Promise.all([
      stationIds.length ? requireDb().from('stations').select('id, name, station_code, status').in('id', stationIds) : Promise.resolve({ data: [] }),
      lineIds.length ? requireDb().from('metro_lines').select('id, name, code, status').in('id', lineIds) : Promise.resolve({ data: [] }),
    ])
    const sMap = Object.fromEntries(stations.map((s) => [s.id, s]))
    const lMap = Object.fromEntries(lines.map((l) => [l.id, l]))

    return machines.map((m) => {
      const s = sMap[m.station_id] || {}
      const l = lMap[m.line_id] || {}
      return withMachineSpec({
        ...m,
        station_name: s.name || null,
        station_code: s.station_code || null,
        line_name: l.name || null,
        line_code: l.code || null,
        stock_percentage: stockPercentage(m),
      })
    })
  }
  return enrichAsync()
}

const enrich = enrichRows

export const findAll = async ({ search, status, stationId, lineId, page = 1, limit = 20 } = {}) => {
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (p - 1) * lim

  let matchingStationIds = null
  if (search) {
    const { data, error } = await requireDb()
      .from('stations')
      .select('id')
      .ilike('name', `%${search}%`)
    if (error) throw normalizeError(error)
    matchingStationIds = data.map((s) => s.id)
  }

  let countQuery = requireDb().from('machines').select('id', { count: 'exact', head: true })
  let dataQuery = requireDb().from('machines').select(MACHINE_SELECT)

  if (search) {
    const orParts = [`machine_id.ilike.%${search}%`, `location.ilike.%${search}%`]
    if (matchingStationIds.length) orParts.push(`station_id.in.(${matchingStationIds.join(',')})`)
    const orClause = orParts.join(',')
    countQuery = countQuery.or(orClause)
    dataQuery = dataQuery.or(orClause)
  }
  if (status) {
    countQuery = countQuery.eq('status', status)
    dataQuery = dataQuery.eq('status', status)
  }
  if (stationId) {
    countQuery = countQuery.eq('station_id', stationId)
    dataQuery = dataQuery.eq('station_id', stationId)
  }
  if (lineId) {
    countQuery = countQuery.eq('line_id', lineId)
    dataQuery = dataQuery.eq('line_id', lineId)
  }

  const { count, error: cErr } = await countQuery
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await dataQuery
    .order('line_id', { ascending: true })
    .order('station_id', { ascending: true })
    .order('machine_id', { ascending: true })
    .range(offset, offset + lim - 1)
  if (error) throw normalizeError(error)

  const machines = await enrich(data)

  return {
    machines,
    meta: {
      page: p,
      limit: lim,
      total: count,
      totalPages: Math.ceil(count / lim),
    },
  }
}

const countByMachine = async (table, machineId) => {
  const { count, error } = await requireDb()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('machine_id', machineId)
  if (error) throw normalizeError(error)
  return count
}

export const findById = async (id) => {
  const { data, error } = await requireDb()
    .from('machines')
    .select(MACHINE_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw normalizeError(error)
  if (!data) return null

  const machine = (await enrich([data]))[0]

  const [refillCount, issueCount, maintenanceCount] = await Promise.all([
    countByMachine('refill_records', id),
    countByMachine('stock_issues', id),
    countByMachine('maintenance_records', id),
  ])

  return {
    ...machine,
    refill_count: refillCount,
    issue_count: issueCount,
    maintenance_count: maintenanceCount,
  }
}

export const findByMachineId = async (machineId) => {
  const { data, error } = await requireDb()
    .from('machines')
    .select('*')
    .eq('machine_id', machineId)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const findByStationId = async (stationId) => {
  const { data, error } = await requireDb()
    .from('machines')
    .select('*')
    .eq('station_id', stationId)
  if (error) throw normalizeError(error)
  return data || []
}

export const create = async ({
  machineId,
  stationId,
  lineId,
  location,
  machineType,
  capacity,
  currentStock = 0,
  lowStockThreshold = 10,
  installationDate,
  status = 'ACTIVE',
  remark,
  createdBy,
} = {}) => {
  const { data, error } = await requireDb()
    .from('machines')
    .insert({
      machine_id: machineId,
      station_id: stationId,
      line_id: lineId,
      location: location || null,
      machine_type: machineType || 'Standard',
      capacity,
      current_stock: currentStock,
      low_stock_threshold: lowStockThreshold,
      installation_date: installationDate || null,
      status,
      remark: remark || null,
      created_by: createdBy || null,
    })
    .select('*')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const update = async (
  id,
  {
    machineId,
    stationId,
    lineId,
    location,
    machineType,
    capacity,
    currentStock,
    lowStockThreshold,
    installationDate,
    status,
    remark,
  } = {}
) => {
  const updates = { updated_at: new Date().toISOString() }
  if (machineId !== undefined) updates.machine_id = machineId
  if (stationId !== undefined) updates.station_id = stationId
  if (lineId !== undefined) updates.line_id = lineId
  if (location !== undefined) updates.location = location
  if (machineType !== undefined) updates.machine_type = machineType
  if (capacity !== undefined) updates.capacity = capacity
  if (currentStock !== undefined) updates.current_stock = currentStock
  if (lowStockThreshold !== undefined) updates.low_stock_threshold = lowStockThreshold
  if (installationDate !== undefined) updates.installation_date = installationDate || null
  if (status !== undefined) updates.status = status
  if (remark !== undefined) updates.remark = remark

  const { data, error } = await requireDb()
    .from('machines')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data || (await findById(id))
}

export const updateStatus = async (id, status) => {
  const { data, error } = await requireDb()
    .from('machines')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const updateLastMaintenance = async (id) => {
  const { data, error } = await requireDb()
    .from('machines')
    .update({ last_maintenance_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const countActive = async () => {
  const { count, error } = await requireDb()
    .from('machines')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'ACTIVE')
  if (error) throw normalizeError(error)
  return count
}

const MACHINE_CHILD_TABLES = [
  'refill_records',
  'stock_issues',
  'maintenance_records',
  'monthly_data',
  'pad_stock',
  'machine_status_history',
  'monthly_refill_status',
]

// Remove every record that references the machine so it can be deleted.
export const purgeMachine = async (id) => {
  const db = requireDb()
  for (const table of MACHINE_CHILD_TABLES) {
    const { error } = await db.from(table).delete().eq('machine_id', id)
    if (error) throw normalizeError(error)
  }
}

export const remove = async (id) => {
  await purgeMachine(id)
  const { data, error } = await requireDb()
    .from('machines')
    .delete()
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}