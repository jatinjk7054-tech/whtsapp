import * as cashCollectionService from '../services/cashCollection.service.js'

export const getMonthly = async (req, res, next) => {
  try {
    const { year, month, lineId, stationId } = req.query
    const result = await cashCollectionService.getMonthlyCollections({ year, month, lineId, stationId })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await cashCollectionService.createCashCollection(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const remove = async (req, res, next) => {
  try {
    const result = await cashCollectionService.removeCashCollection(req.params.id, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}