import * as auditService from '../services/audit.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { entity, page = 1, limit = 20 } = req.query
    const result = await auditService.getLogs({ entity, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}