import * as machineService from '../services/machine.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { search, status, stationId, lineId, page, limit } = req.query
    const result = await machineService.getAllMachines({ search, status, stationId, lineId, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    const result = await machineService.getMachineById(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await machineService.createMachine(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const result = await machineService.updateMachine(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const changeStatus = async (req, res, next) => {
  try {
    const { status, reason } = req.body
    const result = await machineService.changeMachineStatus(req.params.id, status, reason, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getStatusHistory = async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const result = await machineService.getStatusHistory(req.params.id, { page, limit })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

const remove = async (req, res, next) => {
  try {
    const result = await machineService.deleteMachine(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export { remove as delete }
