import * as MetroLineModel from '../models/metroLine.model.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'

export const getAllLines = async (filters = {}) => {
  return MetroLineModel.findAll(filters)
}

export const getLineById = async (id) => {
  const line = await MetroLineModel.findById(id)
  if (!line) {
    throw new AppError('Metro line not found', 404)
  }
  return line
}

export const createLine = async (data, user) => {
  const line = await MetroLineModel.create({
    code: data.code,
    name: data.name,
    description: data.description,
    createdBy: user?.id,
  })
  await AuditService.logAction(user, 'CREATE', 'METRO_LINE', line.id, null, line)
  return line
}

export const updateLine = async (id, data, user) => {
  const existing = await MetroLineModel.findById(id)
  if (!existing) {
    throw new AppError('Metro line not found', 404)
  }

  const updated = await MetroLineModel.update(id, {
    code: data.code !== undefined ? data.code : existing.code,
    name: data.name !== undefined ? data.name : existing.name,
    description: data.description !== undefined ? data.description : existing.description,
  })
  await AuditService.logAction(user, 'UPDATE', 'METRO_LINE', id, existing, updated)
  return updated
}

export const updateLineStatus = async (id, status, user) => {
  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    throw new AppError(`Invalid status: ${status}. Must be ACTIVE or INACTIVE`, 400)
  }

  const existing = await MetroLineModel.findById(id)
  if (!existing) {
    throw new AppError('Metro line not found', 404)
  }

  const updated = await MetroLineModel.updateStatus(id, status)
  await AuditService.logAction(user, 'UPDATE_STATUS', 'METRO_LINE', id, existing, updated)
  return updated
}

export const deleteLine = async (id) => {
  const existing = await MetroLineModel.findById(id)
  if (!existing) {
    throw new AppError('Metro line not found', 404)
  }

  if (Number(existing.station_count) > 0) {
    throw new AppError('Cannot delete line: stations still reference this line', 409)
  }

  await MetroLineModel.remove(id)
  return existing
}