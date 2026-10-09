import * as StationModel from '../models/station.model.js'
import * as MetroLineModel from '../models/metroLine.model.js'
import * as MachineModel from '../models/machine.model.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'
import { MACHINE_CAPACITY } from '../config/machineSpec.js'

export const getAllStations = async (filters = {}) => {
  return StationModel.findAll(filters)
}

export const getStationById = async (id) => {
  const station = await StationModel.findById(id)
  if (!station) {
    throw new AppError('Station not found', 404)
  }
  return station
}

export const createStation = async (data, user) => {
  if (!data.lineId) {
    throw new AppError('lineId is required', 400)
  }

  const line = await MetroLineModel.findById(data.lineId)
  if (!line) {
    throw new AppError('Metro line not found', 400)
  }

  const station = await StationModel.create({
    lineId: data.lineId,
    stationCode: data.stationCode,
    name: data.name,
    description: data.description,
    status: data.status || 'ACTIVE',
    createdBy: user?.id,
  })

  // Every station gets exactly one machine (2 slots x 25 pads = 50 capacity).
  let machine = null
  try {
    machine = await MachineModel.create({
      machineId: `M-${station.station_code}`,
      stationId: station.id,
      lineId: station.line_id,
      location: station.name,
      machineType: 'Standard',
      capacity: MACHINE_CAPACITY,
      currentStock: 0,
      status: 'ACTIVE',
      createdBy: user?.id,
    })
    await AuditService.logAction(user, 'CREATE', 'MACHINE', machine.id, null, machine)
  } catch (err) {
    // Keep data consistent: remove the station if its machine could not be created.
    await StationModel.remove(station.id).catch(() => {})
    throw err
  }

  await AuditService.logAction(user, 'CREATE', 'STATION', station.id, null, station)
  return { ...station, machine }
}

export const updateStation = async (id, data, user) => {
  const existing = await StationModel.findById(id)
  if (!existing) {
    throw new AppError('Station not found', 404)
  }

  if (data.lineId && data.lineId !== existing.line_id) {
    const line = await MetroLineModel.findById(data.lineId)
    if (!line) {
      throw new AppError('Metro line not found', 400)
    }
  }

  const updated = await StationModel.update(id, {
    lineId: data.lineId !== undefined ? data.lineId : existing.line_id,
    stationCode: data.stationCode !== undefined ? data.stationCode : existing.station_code,
    name: data.name !== undefined ? data.name : existing.name,
    description: data.description !== undefined ? data.description : existing.description,
    status: data.status !== undefined ? data.status : existing.status,
  })
  await AuditService.logAction(user, 'UPDATE', 'STATION', id, existing, updated)
  return updated
}

export const deleteStation = async (id) => {
  const existing = await StationModel.findById(id)
  if (!existing) {
    throw new AppError('Station not found', 404)
  }

  if (Number(existing.machine_count) > 0) {
    throw new AppError('Cannot delete station: machines still reference this station', 409)
  }

  await StationModel.remove(id)
  return existing
}