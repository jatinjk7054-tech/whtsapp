import * as stockIssueService from '../services/stockIssue.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { machineId, stationId, lineId, status, issueType, page, limit } = req.query
    const result = await stockIssueService.getAllIssues({ machineId, stationId, lineId, status, issueType, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    const result = await stockIssueService.getIssueById(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getByMachine = async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const result = await stockIssueService.getIssuesByMachine(req.params.machineId, { page, limit })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await stockIssueService.createIssue(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body
    const result = await stockIssueService.updateIssueStatus(req.params.id, status, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
