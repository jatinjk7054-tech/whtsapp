import { requireDb, normalizeError } from '../config/supabase.js'
import { purgeMachine } from './machine.model.js'

const LINE_SELECT = 'id, code, name, description, status, created_at, updated_at'

const buildBase = (db, { search, status } = {}) => {
  let b = db
  if (search) b = b.or(`name.ilike.%${search}%,code.ilike.%${search}%`)
  if (status) b = b.eq('status', status)
  return b
}

const attachCounts = async (lines) => {
  if (!lines.length) return lines
  const lineIds = lines.map((l) => l.id)

  const { data: stations, error: sErr } = await requireDb()
    .from('stations')
    .select('id, line_id')
    .in('line_id', lineIds)
  if (sErr) throw normalizeError(sErr)

  const { data: machines, error: mErr } = await requireDb()
    .from('machines')
    .select('id, line_id, status')
    .in('line_id', lineIds)
  if (mErr) throw normalizeError(mErr)

  const stationCount = {}
  const machineCount = {}
  const activeCount = {}
  const inactiveCount = {}

  for (const s of stations || []) stationCount[s.line_id] = (stationCount[s.line_id] || 0) + 1
  for (const m of machines || []) {
    machineCount[m.line_id] = (machineCount[m.line_id] || 0) + 1
    if (m.status === 'ACTIVE') activeCount[m.line_id] = (activeCount[m.line_id] || 0) + 1
    else if (m.status === 'INACTIVE') inactiveCount[m.line_id] = (inactiveCount[m.line_id] || 0) + 1
  }

  return lines.map((l) => ({
    ...l,
    station_count: stationCount[l.id] || 0,
    machine_count: machineCount[l.id] || 0,
    active_machine_count: activeCount[l.id] || 0,
    inactive_machine_count: inactiveCount[l.id] || 0,
  }))
}

export const findAll = async ({ search, status, page, limit, offset } = {}) => {
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const off = offset !== undefined ? Number(offset) : (p - 1) * lim

  let countQuery = buildBase(requireDb().from('metro_lines').select('id', { count: 'exact', head: true }), { search, status })
  const { count, error: cErr } = await countQuery
  if (cErr) throw normalizeError(cErr)

  const { data, error } = await buildBase(requireDb().from('metro_lines').select(LINE_SELECT), { search, status })
    .order('name', { ascending: true })
    .range(off, off + lim - 1)
  if (error) throw normalizeError(error)

  const lines = await attachCounts(data)

  return {
    lines,
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
    .from('metro_lines')
    .select(LINE_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw normalizeError(error)
  if (!data) return null

  const { data: stations, error: sErr } = await requireDb()
    .from('stations')
    .select('id, name, station_code, status')
    .eq('line_id', id)
    .order('name', { ascending: true })
  if (sErr) throw normalizeError(sErr)

  const stationIds = stations.map((s) => s.id)
  let machineAgg = {}
  if (stationIds.length) {
    const { data: machines, error: mErr } = await requireDb()
      .from('machines')
      .select('id, station_id, status')
      .in('station_id', stationIds)
    if (mErr) throw normalizeError(mErr)
    machineAgg = (machines || []).reduce((acc, m) => {
      acc[m.station_id] = acc[m.station_id] || { machine_count: 0, active_machine_count: 0 }
      acc[m.station_id].machine_count++
      if (m.status === 'ACTIVE') acc[m.station_id].active_machine_count++
      return acc
    }, {})
  }

  let stationSummary = { count: 0, activeCount: 0, machineCount: 0 }
  const enriched = stations.map((s) => {
    const agg = machineAgg[s.id] || { machine_count: 0, active_machine_count: 0 }
    return { ...s, ...agg }
  })
  stationSummary = {
    count: enriched.length,
    activeCount: enriched.filter((s) => s.status === 'ACTIVE').length,
    machineCount: enriched.reduce((t, s) => t + s.machine_count, 0),
  }

  return {
    ...data,
    station_count: stationSummary.count,
    machine_count: stationSummary.machineCount,
    active_machine_count: enriched.reduce((t, s) => t + s.active_machine_count, 0),
    inactive_machine_count: enriched.reduce((t, s) => t + (s.machine_count - s.active_machine_count), 0),
    stations: enriched,
  }
}

export const create = async ({ code, name, description, createdBy }) => {
  const { data, error } = await requireDb()
    .from('metro_lines')
    .insert({ code, name, description: description || null, created_by: createdBy || null })
    .select('*')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const update = async (id, { code, name, description } = {}) => {
  const { data, error } = await requireDb()
    .from('metro_lines')
    .update({ code, name, description: description || null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const updateStatus = async (id, status) => {
  const { data, error } = await requireDb()
    .from('metro_lines')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

const LINE_CHILD_TABLES = [
  'refill_records',
  'stock_issues',
  'maintenance_records',
  'cash_collections',
  'monthly_data',
]

export const remove = async (id) => {
  const db = requireDb()

  const { data: stations, error: sErr } = await db
    .from('stations')
    .select('id')
    .eq('line_id', id)
  if (sErr) throw normalizeError(sErr)

  for (const station of stations || []) {
    const { data: machines, error: mErr } = await db
      .from('machines')
      .select('id')
      .eq('station_id', station.id)
    if (mErr) throw normalizeError(mErr)
    for (const m of machines || []) {
      await purgeMachine(m.id)
    }
    for (const table of LINE_CHILD_TABLES) {
      const { error } = await db.from(table).delete().eq('station_id', station.id)
      if (error) throw normalizeError(error)
    }
    const { error: machErr } = await db
      .from('machines')
      .delete()
      .eq('station_id', station.id)
    if (machErr) throw normalizeError(machErr)
  }

  const { error: stErr } = await db.from('stations').delete().eq('line_id', id)
  if (stErr) throw normalizeError(stErr)

  const { error: mdErr } = await db.from('monthly_data').delete().eq('line_id', id)
  if (mdErr) throw normalizeError(mdErr)

  const { data, error } = await db
    .from('metro_lines')
    .delete()
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}