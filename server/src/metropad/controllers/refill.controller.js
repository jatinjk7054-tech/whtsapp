import * as refillService from '../services/refill.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { machineId, stationId, lineId, dateFrom, dateTo, page, limit } = req.query
    const result = await refillService.getAllRefills({ machineId, stationId, lineId, dateFrom, dateTo, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getByMachine = async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const result = await refillService.getRefillHistory(req.params.machineId, { page, limit })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getRecent = async (req, res, next) => {
  try {
    const { limit } = req.query
    const result = await refillService.getRecentRefills(limit)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await refillService.recordRefill(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const result = await refillService.updateRefill(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const remove = async (req, res, next) => {
  try {
    const result = await refillService.deleteRefill(req.params.id, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
