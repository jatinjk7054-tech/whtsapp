import * as MaintenanceModel from '../models/maintenance.model.js'
import * as MachineModel from '../models/machine.model.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'

const VALID_MAINTENANCE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']
const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))

const resolveMachine = async (machineId) => {
  if (isUUID(machineId)) {
    return MachineModel.findById(machineId)
  }
  return MachineModel.findByMachineId(machineId)
}

export const getAllMaintenance = async (filters = {}) => {
  return MaintenanceModel.findAll(filters)
}

export const getMaintenanceById = async (id) => {
  const record = await MaintenanceModel.findById(id)
  if (!record) {
    throw new AppError('Maintenance record not found', 404)
  }
  return record
}

export const getMaintenanceByMachine = async (machineId, pagination = {}) => {
  const machine = await resolveMachine(machineId)
  if (!machine) {
    throw new AppError('Machine not found', 404)
  }
  return MaintenanceModel.findByMachineId(machine.id, pagination)
}

export const createMaintenance = async (data, user) => {
  if (!data.machineId) {
    throw new AppError('machineId is required', 400)
  }
  if (!data.problem) {
    throw new AppError('problem is required', 400)
  }

  const machine = await resolveMachine(data.machineId)
  if (!machine) {
    throw new AppError('Machine not found', 400)
  }

  const record = await MaintenanceModel.create({
    machineId: machine.id,
    stationId: data.stationId || machine.station_id,
    problem: data.problem,
    reportedDate: data.reportedDate || new Date(),
    priority: data.priority || 'MEDIUM',
    technician: data.technician,
    status: data.status || 'OPEN',
    remark: data.remark,
    createdBy: user?.id,
  })
  await AuditService.logAction(user, 'CREATE', 'MAINTENANCE', record.id, null, record)
  return record
}

export const updateMaintenance = async (id, data, user) => {
  const existing = await MaintenanceModel.findById(id)
  if (!existing) {
    throw new AppError('Maintenance record not found', 404)
  }

  if (data.status && !VALID_MAINTENANCE_STATUSES.includes(data.status)) {
    throw new AppError(`Invalid maintenance status: ${data.status}`, 400)
  }

  const transitionsToResolved = data.status === 'RESOLVED' && existing.status !== 'RESOLVED'

  const updated = await MaintenanceModel.update(id, {
    problem: data.problem !== undefined ? data.problem : existing.problem,
    priority: data.priority !== undefined ? data.priority : existing.priority,
    technician: data.technician !== undefined ? data.technician : existing.technician,
    status: data.status !== undefined ? data.status : existing.status,
    reportedDate: data.reportedDate !== undefined ? data.reportedDate : existing.reported_date,
    resolvedDate: data.resolvedDate,
    remark: data.remark !== undefined ? data.remark : existing.remark,
  })

  if (transitionsToResolved) {
    await MachineModel.updateLastMaintenance(existing.machine_id)
  }

  await AuditService.logAction(user, 'UPDATE', 'MAINTENANCE', id, existing, updated)
  return updated
}

export const countActive = async () => {
  return MaintenanceModel.countActive()
}