import * as stationService from '../services/station.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { search, status, lineId, page, limit } = req.query
    const result = await stationService.getAllStations({ search, status, lineId, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    const result = await stationService.getStationById(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await stationService.createStation(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const result = await stationService.updateStation(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

const remove = async (req, res, next) => {
  try {
    const result = await stationService.deleteStation(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export { remove as delete }
