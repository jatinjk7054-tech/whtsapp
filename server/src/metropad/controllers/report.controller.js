import * as reportService from '../services/report.service.js'

export const getStationReport = async (req, res, next) => {
  try {
    const { lineId, stationId, machineId, status, search } = req.query
    const result = await reportService.getStationReport({ lineId, stationId, machineId, status, search })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getMachineReport = async (req, res, next) => {
  try {
    const { lineId, stationId, machineId, status, search } = req.query
    const result = await reportService.getMachineReport({ lineId, stationId, machineId, status, search })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getMetroLineReport = async (req, res, next) => {
  try {
    const { lineId, stationId, machineId, status, search } = req.query
    const result = await reportService.getMetroLineReport({ lineId, stationId, machineId, status, search })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getMonthlyReport = async (req, res, next) => {
  try {
    const { lineId, stationId, machineId, status, search, year, month } = req.query
    const result = await reportService.getMonthlyReport({ lineId, stationId, machineId, status, search, year, month })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getRefillReport = async (req, res, next) => {
  try {
    const { machineId, stationId, lineId, dateFrom, dateTo, refilledBy } = req.query
    const result = await reportService.getRefillReport({ machineId, stationId, lineId, dateFrom, dateTo, refilledBy })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const exportReport = async (req, res, next) => {
  try {
    const { type } = req.params
    const { format, ...filters } = req.query
    const fmt = (format || 'csv').toLowerCase()

    let buffer
    let contentType
    let extension

    if (fmt === 'xlsx') {
      buffer = await reportService.exportExcel(type, filters)
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      extension = 'xlsx'
    } else if (fmt === 'pdf') {
      buffer = await reportService.exportPDF(type, filters)
      contentType = 'application/pdf'
      extension = 'pdf'
    } else {
      buffer = await reportService.exportCSV(type, filters)
      contentType = 'text/csv'
      extension = 'csv'
    }

    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename="report-${type}-${Date.now()}.${extension}"`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    next(err)
  }
}
