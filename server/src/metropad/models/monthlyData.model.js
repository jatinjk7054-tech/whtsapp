import { requireDb, normalizeError } from '../config/supabase.js'

const MONTHLY_DATA_SELECT = [
  'id',
  'record_date',
  'year_month',
  'line_id',
  'station_id',
  'machine_id',
  'cash_collected',
  'pads_refilled',
  'machine_status',
  'issue_type',
  'notes',
  'next_action',
  'created_by',
  'created_at',
  'updated_at',
].join(', ')

export const isTableMissing = (err) => {
  const msg = String(err?.message || '')
  return (
    /does not exist/i.test(msg) ||
    /Could not find the table/i.test(msg) ||
    /42P01|PGRST205|PGRST204/i.test(String(err?.code || ''))
  )
}

const buildJoinQuery = (query) => {
  return query
    .select(
      `${MONTHLY_DATA_SELECT}, metro_lines(line_name, color), stations(station_code, station_name), machines(machine_id, model)`
    )
}

export const findById = async (id) => {
  const { data, error } = await requireDb()
    .from('monthly_data')
    .select(MONTHLY_DATA_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const findByMachineAndDate = async (machineId, recordDate) => {
  const { data, error } = await requireDb()
    .from('monthly_data')
    .select(MONTHLY_DATA_SELECT)
    .eq('machine_id', machineId)
    .eq('record_date', recordDate)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const findRecords = async ({ yearMonth, lineId, stationId, machineId, startDate, endDate }) => {
  let query = buildJoinQuery(requireDb().from('monthly_data'))

  if (yearMonth) query = query.eq('year_month', yearMonth)
  if (lineId) query = query.eq('line_id', lineId)
  if (stationId) query = query.eq('station_id', stationId)
  if (machineId) query = query.eq('machine_id', machineId)
  if (startDate && endDate) {
    query = query.gte('record_date', startDate).lt('record_date', endDate)
  }

  query = query.order('record_date', { ascending: false }).order('created_at', { ascending: false })

  const { data, error } = await query
  if (error) throw normalizeError(error)

  const rows = (data || []).map((r) => ({
    ...r,
    line_name: r.metro_lines?.line_name || null,
    line_color: r.metro_lines?.color || null,
    station_code: r.stations?.station_code || null,
    station_name: r.stations?.station_name || null,
    machine_code: r.machines?.machine_id || null,
    machine_model: r.machines?.model || null,
    metro_lines: undefined,
    stations: undefined,
    machines: undefined,
  }))

  return rows
}

export const insert = async (payload) => {
  const { data, error } = await requireDb()
    .from('monthly_data')
    .upsert(payload, { onConflict: 'machine_id,record_date' })
    .select(MONTHLY_DATA_SELECT)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const remove = async (id) => {
  const { data, error } = await requireDb()
    .from('monthly_data')
    .delete()
    .eq('id', id)
    .select(MONTHLY_DATA_SELECT)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}