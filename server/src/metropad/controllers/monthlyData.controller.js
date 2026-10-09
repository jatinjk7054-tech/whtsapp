import * as monthlyDataService from '../services/monthlyData.service.js'

export const getMonthlyData = async (req, res, next) => {
  try {
    const { year, month, lineId, stationId, machineId } = req.query
    const result = await monthlyDataService.getMonthlyData({ year, month, lineId, stationId, machineId })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getMonthlyRecords = async (req, res, next) => {
  try {
    const { year, month, lineId, stationId, machineId } = req.query
    const result = await monthlyDataService.getMonthlyRecords({ year, month, lineId, stationId, machineId })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const createMonthlyRecord = async (req, res, next) => {
  try {
    const result = await monthlyDataService.createMonthlyRecord(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}