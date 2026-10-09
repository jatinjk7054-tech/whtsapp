import * as metroLineService from '../services/metroLine.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { search, status, page, limit } = req.query
    const result = await metroLineService.getAllLines({ search, status, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    const result = await metroLineService.getLineById(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await metroLineService.createLine(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const result = await metroLineService.updateLine(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body
    const result = await metroLineService.updateLineStatus(req.params.id, status, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

const remove = async (req, res, next) => {
  try {
    const result = await metroLineService.deleteLine(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export { remove as delete }
