import { requireDb, normalizeError } from '../config/supabase.js'

const COLLECTION_SELECT = 'id, station_id, record_date, cash_collected, remark, created_at, updated_at'

export const isTableMissing = (err) => {
  const msg = String(err?.message || '')
  return (
    /does not exist/i.test(msg) ||
    /Could not find the table/i.test(msg) ||
    /42P01|PGRST205|PGRST204/i.test(String(err?.code || ''))
  )
}

export const findBetween = async (stationIds, start, end) => {
  if (!stationIds.length) return { data: [], error: null }
  const { data, error } = await requireDb()
    .from('cash_collections')
    .select(COLLECTION_SELECT)
    .in('station_id', stationIds)
    .gte('record_date', start)
    .lt('record_date', end)
    .order('record_date', { ascending: false })
  return { data: data || [], error }
}

export const findByStation = async (stationId, start, end) => {
  const { data, error } = await requireDb()
    .from('cash_collections')
    .select(COLLECTION_SELECT)
    .eq('station_id', stationId)
    .gte('record_date', start)
    .lt('record_date', end)
    .order('record_date', { ascending: false })
  return { data: data || [], error }
}

export const insert = async (payload) => {
  const { data, error } = await requireDb()
    .from('cash_collections')
    .upsert(payload, { onConflict: 'station_id,record_date' })
    .select(COLLECTION_SELECT)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const remove = async (id) => {
  const { data, error } = await requireDb()
    .from('cash_collections')
    .delete()
    .eq('id', id)
    .select(COLLECTION_SELECT)
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}