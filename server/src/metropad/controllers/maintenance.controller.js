import * as maintenanceService from '../services/maintenance.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { machineId, stationId, lineId, status, priority, page, limit } = req.query
    const result = await maintenanceService.getAllMaintenance({ machineId, stationId, lineId, status, priority, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    const result = await maintenanceService.getMaintenanceById(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getByMachine = async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const result = await maintenanceService.getMaintenanceByMachine(req.params.machineId, { page, limit })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await maintenanceService.createMaintenance(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const result = await maintenanceService.updateMaintenance(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
