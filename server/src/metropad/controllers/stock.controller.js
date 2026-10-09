import * as stockService from '../services/stock.service.js'
import * as refillService from '../services/refill.service.js'

export const getConfig = async (req, res, next) => {
  try {
    const config = await stockService.getConfig()
    res.json({ success: true, data: config })
  } catch (err) {
    next(err)
  }
}

export const updateConfig = async (req, res, next) => {
  try {
    const config = await stockService.updateConfig(req.body, req.user)
    res.json({ success: true, data: config })
  } catch (err) {
    next(err)
  }
}

export const getStockSummary = async (req, res, next) => {
  try {
    const summary = await stockService.getStockSummary()
    res.json({ success: true, data: summary })
  } catch (err) {
    next(err)
  }
}

export const getStationWiseStock = async (req, res, next) => {
  try {
    const stations = await stockService.getStationWiseStock()
    res.json({ success: true, data: stations })
  } catch (err) {
    next(err)
  }
}

export const getMonthlyStockReport = async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear()
    const month = Number(req.query.month) || (new Date().getMonth() + 1)
    const report = await stockService.getMonthlyStockReport(year, month)
    res.json({ success: true, data: report })
  } catch (err) {
    next(err)
  }
}

export const getRemainingCentralStock = async (req, res, next) => {
  try {
    const remaining = await stockService.getRemainingCentralStock()
    res.json({ success: true, data: { remaining } })
  } catch (err) {
    next(err)
  }
}

export const setMonthlyRefillStatus = async (req, res, next) => {
  try {
    const { machineId, yearMonth, refillStatus, remark } = req.body
    const result = await stockService.setMonthlyRefillStatus(
      { machineId, yearMonth, refillStatus, remark },
      req.user
    )
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const saveMonthlyRefill = async (req, res, next) => {
  try {
    const result = await refillService.saveMonthlyRefill(
      { ...req.body, machineId: req.params.machineId },
      req.user
    )
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
