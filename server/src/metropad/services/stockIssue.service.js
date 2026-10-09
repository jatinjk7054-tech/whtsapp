import * as StockIssueModel from '../models/stockIssue.model.js'
import * as MachineModel from '../models/machine.model.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'

const VALID_ISSUE_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED']
const isUUID = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))

const resolveMachine = async (machineId) => {
  if (isUUID(machineId)) {
    return MachineModel.findById(machineId)
  }
  return MachineModel.findByMachineId(machineId)
}

export const getAllIssues = async (filters = {}) => {
  return StockIssueModel.findAll(filters)
}

export const getIssueById = async (id) => {
  const issue = await StockIssueModel.findById(id)
  if (!issue) {
    throw new AppError('Stock issue not found', 404)
  }
  return issue
}

export const getIssuesByMachine = async (machineId, pagination = {}) => {
  const machine = await resolveMachine(machineId)
  if (!machine) {
    throw new AppError('Machine not found', 404)
  }
  return StockIssueModel.findByMachineId(machine.id, pagination)
}

export const createIssue = async (data, user) => {
  if (!data.machineId) {
    throw new AppError('machineId is required', 400)
  }

  const machine = await resolveMachine(data.machineId)
  if (!machine) {
    throw new AppError('Machine not found', 400)
  }

  if (data.missingQuantity === undefined || Number(data.missingQuantity) < 0) {
    throw new AppError('missingQuantity must be a non-negative number', 400)
  }

  const issue = await StockIssueModel.create({
    machineId: machine.id,
    stationId: data.stationId || machine.station_id,
    reportDate: data.reportDate || new Date(),
    expectedStock: data.expectedStock,
    actualStock: data.actualStock,
    missingQuantity: Number(data.missingQuantity),
    issueType: data.issueType || 'MISSING_PADS',
    reason: data.reason,
    status: data.status || 'OPEN',
    reportedBy: user?.name || data.reportedBy || 'System',
    remark: data.remark,
    createdBy: user?.id,
  })
  await AuditService.logAction(user, 'CREATE', 'STOCK_ISSUE', issue.id, null, issue)
  return issue
}

export const updateIssueStatus = async (id, status, user) => {
  if (!VALID_ISSUE_STATUSES.includes(status)) {
    throw new AppError(`Invalid issue status: ${status}`, 400)
  }

  const existing = await StockIssueModel.findById(id)
  if (!existing) {
    throw new AppError('Stock issue not found', 404)
  }

  const updated = await StockIssueModel.updateStatus(id, status, user)
  await AuditService.logAction(user, 'UPDATE_STATUS', 'STOCK_ISSUE', id, existing, updated)
  return updated
}