import * as XLSX from 'xlsx'
import { requireDb, normalizeError } from '../config/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

const EXPECTED_HEADERS = [
  'Metro Line',
  'Station ID',
  'Station Name',
  'Station Code',
  'Machine ID',
  'Machine Location',
  'Machine Capacity',
  'Current Stock',
  'Machine Status',
  'Installation Date',
  'Remark',
]

const normalizeHeader = (h) =>
  String(h || '').trim().toLowerCase().replace(/\s+/g, ' ')

const REQUIRED_FIELDS = ['Metro Line', 'Station Code', 'Machine ID', 'Machine Capacity']

const VALID_STATUSES = ['ACTIVE', 'INACTIVE', 'OFFLINE', 'MAINTENANCE']

const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))

const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(String(str).trim())

export const validateImport = async (buffer, filename) => {
  let workbook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    throw new AppError('Failed to parse file. Ensure it is a valid Excel or CSV file.', 400)
  }

  const sheetName = workbook.SheetNames[0]
  if (!sheetName) {
    throw new AppError('File contains no sheets', 400)
  }

  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })

  if (!rows.length) {
    throw new AppError('File contains no data rows', 400)
  }

  const rawHeaders = Object.keys(rows[0])
  const normalizedMap = {}
  for (const h of rawHeaders) {
    normalizedMap[normalizeHeader(h)] = h
  }

  const missingRequired = REQUIRED_FIELDS.filter(
    (f) => !normalizedMap[normalizeHeader(f)]
  )
  if (missingRequired.length) {
    throw new AppError(
      `Invalid file: missing required column${missingRequired.length > 1 ? 's' : ''} ${missingRequired.join(', ')}`,
      400
    )
  }

  const lineCache = new Map()
  const stationCache = new Map()
  const machineIdCache = new Set()

  const existingMachines = await requireDb().from('machines').select('machine_id')
  if (existingMachines.error) throw normalizeError(existingMachines.error)
  for (const row of existingMachines.data || []) {
    machineIdCache.add(String(row.machine_id).trim().toUpperCase())
  }

  const allLines = await requireDb().from('metro_lines').select('id, name, code')
  if (allLines.error) throw normalizeError(allLines.error)

  const valid = []
  const invalid = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2
    const errors = []

    const getVal = (fieldName) => {
      const key = normalizedMap[normalizeHeader(fieldName)]
      return key !== undefined ? String(row[key] || '').trim() : ''
    }

    const metroLine = getVal('Metro Line')
    const stationCode = getVal('Station Code')
    const machineId = getVal('Machine ID')
    const capacity = getVal('Machine Capacity')
    const currentStock = getVal('Current Stock')
    const status = getVal('Machine Status') || 'ACTIVE'
    const installationDate = getVal('Installation Date')

    if (!metroLine) errors.push('Metro Line is required')
    if (!stationCode) errors.push('Station Code is required')
    if (!machineId) errors.push('Machine ID is required')
    if (!capacity) errors.push('Machine Capacity is required')

    if (capacity) {
      const cap = Number(capacity)
      if (!Number.isInteger(cap) || cap <= 0) {
        errors.push('Machine Capacity must be a positive integer')
      }
    }

    if (currentStock) {
      const stock = Number(currentStock)
      if (!Number.isInteger(stock) || stock < 0) {
        errors.push('Current Stock must be a non-negative integer')
      }
      if (capacity && Number(currentStock) > Number(capacity)) {
        errors.push('Current Stock cannot exceed Machine Capacity')
      }
    }

    if (status && !VALID_STATUSES.includes(status.toUpperCase())) {
      errors.push(`Invalid Machine Status: ${status}. Must be one of ${VALID_STATUSES.join(', ')}`)
    }

    if (installationDate && !isValidDate(installationDate)) {
      errors.push('Installation Date must be in YYYY-MM-DD format')
    }

    if (metroLine) {
      const lineKey = metroLine.toLowerCase()
      if (!lineCache.has(lineKey)) {
        const found = allLines.data.find(
          (l) => String(l.name).toLowerCase() === lineKey || String(l.code).toLowerCase() === lineKey
        )
        lineCache.set(lineKey, found || null)
      }
      if (!lineCache.get(lineKey)) {
        errors.push(`Metro Line "${metroLine}" not found`)
      }
    }

    if (stationCode) {
      const codeKey = stationCode.toUpperCase()
      if (!stationCache.has(codeKey)) {
        const { data: found, error: sErr } = await requireDb()
          .from('stations')
          .select('id, station_code')
          .or(`station_code.eq.${stationCode},station_code.eq.${codeKey}`)
        if (sErr) throw normalizeError(sErr)
        const match = found.find((s) => String(s.station_code).toUpperCase() === codeKey)
        stationCache.set(codeKey, match || null)
      }
      if (!stationCache.get(codeKey)) {
        errors.push(`Station with code "${stationCode}" not found`)
      }
    }

    if (machineId) {
      const mIdKey = machineId.toUpperCase()
      if (machineIdCache.has(mIdKey)) {
        errors.push(`Machine ID "${machineId}" already exists in the system`)
      }
    }

    const data = {
      metroLine,
      stationCode,
      stationName: getVal('Station Name'),
      machineId,
      location: getVal('Machine Location'),
      capacity: capacity ? Number(capacity) : null,
      currentStock: currentStock ? Number(currentStock) : 0,
      status: status.toUpperCase(),
      installationDate: installationDate || null,
      remark: getVal('Remark'),
    }

    if (errors.length) {
      invalid.push({ rowNumber: rowNum, data, valid: false, errors })
    } else {
      valid.push({ rowNumber: rowNum, data, valid: true })
      machineIdCache.add(machineId.toUpperCase())
    }
  }

  return {
    valid,
    invalid,
    meta: {
      total: rows.length,
      validCount: valid.length,
      invalidCount: invalid.length,
    },
  }
}

export const confirmImport = async (validRows, user) => {
  if (!Array.isArray(validRows) || validRows.length === 0) {
    throw new AppError('No valid rows to import', 400)
  }

  const { data: allLines, error: lineErr } = await requireDb().from('metro_lines').select('id, name, code')
  if (lineErr) throw normalizeError(lineErr)

  const results = []

  for (const row of validRows) {
    try {
      const { data } = row

      const line = allLines.find(
        (l) => String(l.name).toLowerCase() === data.metroLine.toLowerCase() || String(l.code).toLowerCase() === data.metroLine.toLowerCase()
      )
      if (!line) throw new Error(`Metro Line "${data.metroLine}" not found`)
      const lineId = line.id

      const { data: stations, error: sErr } = await requireDb()
        .from('stations')
        .select('id, station_code')
        .or(`station_code.eq.${data.stationCode},station_code.eq.${data.stationCode.toUpperCase()}`)
      if (sErr) throw normalizeError(sErr)
      const station = stations.find((s) => String(s.station_code).toUpperCase() === data.stationCode.toUpperCase())
      if (!station) throw new Error(`Station "${data.stationCode}" not found`)
      const stationId = station.id

      const { data: existing, error: eErr } = await requireDb()
        .from('machines')
        .select('id')
        .ilike('machine_id', data.machineId)
        .limit(1)
      if (eErr) throw normalizeError(eErr)

      const machineRow = existing[0]

      if (machineRow) {
        const machineUpdates = {
          capacity: data.capacity,
          current_stock: data.currentStock,
          status: data.status,
          updated_at: new Date().toISOString(),
        }
        if (data.location || data.remark || data.installationDate) {
          if (data.location) machineUpdates.location = data.location
          if (data.installationDate) machineUpdates.installation_date = data.installationDate
          if (data.remark) machineUpdates.remark = data.remark
        }
        const { error: uErr } = await requireDb()
          .from('machines')
          .update(machineUpdates)
          .eq('id', machineRow.id)
        if (uErr) throw normalizeError(uErr)
        results.push({ machineId: data.machineId, action: 'updated' })
      } else {
        const { error: iErr } = await requireDb()
          .from('machines')
          .insert({
            machine_id: data.machineId,
            station_id: stationId,
            line_id: lineId,
            location: data.location || null,
            capacity: data.capacity,
            current_stock: data.currentStock,
            status: data.status,
            installation_date: data.installationDate || null,
            remark: data.remark || null,
            created_by: user?.id || null,
          })
        if (iErr) throw normalizeError(iErr)
        results.push({ machineId: data.machineId, action: 'inserted' })
      }
    } catch (err) {
      throw new AppError(`Import failed at row for machine "${row.data?.machineId}": ${err.message}`, 400)
    }
  }

  return {
    imported: results.filter((r) => r.action === 'inserted').length,
    updated: results.filter((r) => r.action === 'updated').length,
    failed: 0,
    results,
  }
}
