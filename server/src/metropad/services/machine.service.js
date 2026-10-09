import * as MachineModel from '../models/machine.model.js'
import * as MachineStatusHistoryModel from '../models/machineStatusHistory.model.js'
import * as StationModel from '../models/station.model.js'
import * as MetroLineModel from '../models/metroLine.model.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'
import { MACHINE_CAPACITY } from '../config/machineSpec.js'

const VALID_MACHINE_STATUSES = ['ACTIVE', 'INACTIVE', 'OFFLINE', 'MAINTENANCE']

export const getAllMachines = async (filters = {}) => {
  return MachineModel.findAll(filters)
}

export const getMachineById = async (id) => {
  const machine = await MachineModel.findById(id)
  if (!machine) {
    throw new AppError('Machine not found', 404)
  }
  return machine
}

export const createMachine = async (data, user) => {
  if (!data.stationId) {
    throw new AppError('stationId is required', 400)
  }
  if (!data.lineId) {
    throw new AppError('lineId is required', 400)
  }
  if (!data.machineId) {
    throw new AppError('machineId is required', 400)
  }

  // Every station has exactly one machine with a fixed capacity of 50 pads
  // (2 slots x 25 pads). Capacity is not user-editable.
  const capacity = MACHINE_CAPACITY

  const currentStock = data.currentStock !== undefined ? Number(data.currentStock) : 0
  if (!Number.isInteger(currentStock) || currentStock < 0) {
    throw new AppError('currentStock must be a non-negative integer', 400)
  }
  if (currentStock > capacity) {
    throw new AppError(`currentStock (${currentStock}) cannot exceed capacity (${capacity})`, 400)
  }

  if (data.status && !VALID_MACHINE_STATUSES.includes(data.status)) {
    throw new AppError(`Invalid machine status: ${data.status}`, 400)
  }

  const station = await StationModel.findById(data.stationId)
  if (!station) {
    throw new AppError('Station not found', 400)
  }

  const stationMachines = await MachineModel.findByStationId(data.stationId)
  if (stationMachines.length > 0) {
    throw new AppError('Station already has a machine', 409)
  }

  const line = await MetroLineModel.findById(data.lineId)
  if (!line) {
    throw new AppError('Metro line not found', 400)
  }

  const existingMachine = await MachineModel.findByMachineId(data.machineId)
  if (existingMachine) {
    throw new AppError(`Machine ID ${data.machineId} already exists`, 409)
  }

  const machine = await MachineModel.create({
    machineId: data.machineId,
    stationId: data.stationId,
    lineId: data.lineId,
    location: data.location,
    machineType: data.machineType,
    capacity,
    currentStock,
    lowStockThreshold: data.lowStockThreshold !== undefined ? Number(data.lowStockThreshold) : 10,
    installationDate: data.installationDate,
    status: data.status || 'ACTIVE',
    remark: data.remark,
    createdBy: user?.id,
  })
  await AuditService.logAction(user, 'CREATE', 'MACHINE', machine.id, null, machine)
  return machine
}

export const updateMachine = async (id, data, user) => {
  const existing = await MachineModel.findById(id)
  if (!existing) {
    throw new AppError('Machine not found', 404)
  }

  // Capacity is fixed for every machine (2 slots x 25 pads).
  const capacity = MACHINE_CAPACITY

  const currentStock = data.currentStock !== undefined ? Number(data.currentStock) : existing.current_stock
  if (!Number.isInteger(currentStock) || currentStock < 0) {
    throw new AppError('currentStock must be a non-negative integer', 400)
  }
  if (currentStock > capacity) {
    throw new AppError(`currentStock (${currentStock}) cannot exceed capacity (${capacity})`, 400)
  }

  if (data.status && !VALID_MACHINE_STATUSES.includes(data.status)) {
    throw new AppError(`Invalid machine status: ${data.status}`, 400)
  }

  if (data.stationId) {
    const station = await StationModel.findById(data.stationId)
    if (!station) {
      throw new AppError('Station not found', 400)
    }
    if (data.stationId !== existing.station_id) {
      const stationMachines = await MachineModel.findByStationId(data.stationId)
      if (stationMachines.length > 0) {
        throw new AppError('Station already has a machine', 409)
      }
    }
  }

  if (data.lineId) {
    const line = await MetroLineModel.findById(data.lineId)
    if (!line) {
      throw new AppError('Metro line not found', 400)
    }
  }

  const updated = await MachineModel.update(id, {
    machineId: data.machineId !== undefined ? data.machineId : existing.machine_id,
    stationId: data.stationId !== undefined ? data.stationId : existing.station_id,
    lineId: data.lineId !== undefined ? data.lineId : existing.line_id,
    location: data.location !== undefined ? data.location : existing.location,
    machineType: data.machineType !== undefined ? data.machineType : existing.machine_type,
    capacity,
    currentStock,
    lowStockThreshold: data.lowStockThreshold !== undefined ? Number(data.lowStockThreshold) : existing.low_stock_threshold,
    installationDate: data.installationDate !== undefined ? data.installationDate : existing.installation_date,
    status: data.status !== undefined ? data.status : existing.status,
    remark: data.remark !== undefined ? data.remark : existing.remark,
  })
  await AuditService.logAction(user, 'UPDATE', 'MACHINE', id, existing, updated)
  return updated
}

export const changeMachineStatus = async (id, newStatus, reason, user) => {
  if (!VALID_MACHINE_STATUSES.includes(newStatus)) {
    throw new AppError(`Invalid machine status: ${newStatus}`, 400)
  }

  const existing = await MachineModel.findById(id)
  if (!existing) {
    throw new AppError('Machine not found', 404)
  }

  if (existing.status === newStatus) {
    throw new AppError(`Machine is already ${newStatus}`, 400)
  }

  const updated = await MachineModel.updateStatus(id, newStatus)

  await MachineStatusHistoryModel.create({
    machineId: id,
    previousStatus: existing.status,
    newStatus,
    changedBy: user?.id,
    reason: reason || null,
  })

  await AuditService.logAction(user, 'CHANGE_STATUS', 'MACHINE', id, existing, updated)
  return { ...updated, previous_status: existing.status }
}

export const getStatusHistory = async (machineId, pagination = {}) => {
  const machine = await MachineModel.findById(machineId)
  if (!machine) {
    throw new AppError('Machine not found', 404)
  }
  return MachineStatusHistoryModel.findByMachineId(machineId, pagination)
}

export const deleteMachine = async (id) => {
  const existing = await MachineModel.findById(id)
  if (!existing) {
    throw new AppError('Machine not found', 404)
  }
  await MachineModel.remove(id)
  return existing
}