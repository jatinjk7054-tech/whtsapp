import * as dashboardService from '../services/dashboard.service.js'

export const getStats = async (req, res, next) => {
  try {
    const { lineId, stationId, status } = req.query
    const result = await dashboardService.getStats({ lineId, stationId, status })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getLowStockAlerts = async (req, res, next) => {
  try {
    const { lineId, stationId } = req.query
    const result = await dashboardService.getLowStockAlerts({ lineId, stationId })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getAttentionMachines = async (req, res, next) => {
  try {
    const { lineId, stationId } = req.query
    const result = await dashboardService.getAttentionMachines({ lineId, stationId })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getRecentRefills = async (req, res, next) => {
  try {
    const { limit } = req.query
    const result = await dashboardService.getRecentRefills(limit)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getOverview = async (req, res, next) => {
  try {
    const { lineId, stationId, status } = req.query
    const result = await dashboardService.getOverview({ lineId, stationId, status })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
