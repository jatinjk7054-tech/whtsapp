import { createAuditLog, getAuditLogs } from '../models/audit.model.js'

export const logAction = async (user, action, entity, entityId, oldValue, newValue) => {
  await createAuditLog({
    userId: user?.id,
    userName: user?.name || 'System',
    action,
    entity,
    entityId,
    oldValue,
    newValue,
  })
}

export const getLogs = async (filters = {}) => {
  return getAuditLogs(filters)
}