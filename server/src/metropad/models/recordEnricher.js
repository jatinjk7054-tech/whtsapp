import { requireDb, normalizeError } from '../config/supabase.js'

export const enrichRecordRows = async (rows) => {
  if (!rows.length) return []

  const machineIds = [...new Set(rows.map((r) => r.machine_id))]
  const stationIds = [...new Set(rows.map((r) => r.station_id))]

  const [machinesRes, stationsRes] = await Promise.all([
    requireDb().from('machines').select('id, machine_id, location, line_id').in('id', machineIds),
    requireDb().from('stations').select('id, name, station_code').in('id', stationIds),
  ])
  if (machinesRes.error) throw normalizeError(machinesRes.error)
  if (stationsRes.error) throw normalizeError(stationsRes.error)

  const machines = machinesRes.data
  const stations = stationsRes.data

  const machineMap = Object.fromEntries(machines.map((m) => [m.id, m]))
  const stationMap = Object.fromEntries(stations.map((s) => [s.id, s]))

  const lineIds = [...new Set(machines.map((m) => m.line_id))]
  const linesRes = lineIds.length
    ? await requireDb().from('metro_lines').select('id, name, code').in('id', lineIds)
    : { data: [], error: null }
  if (linesRes.error) throw normalizeError(linesRes.error)
  const lineMap = Object.fromEntries(linesRes.data.map((l) => [l.id, l]))

  return rows.map((row) => {
    const m = machineMap[row.machine_id] || {}
    const s = stationMap[row.station_id] || {}
    const l = lineMap[m.line_id] || {}
    return {
      ...row,
      machine_code: m.machine_id || null,
      location: m.location || null,
      station_name: s.name || null,
      station_code: s.station_code || null,
      line_name: l.name || null,
      line_code: l.code || null,
    }
  })
}