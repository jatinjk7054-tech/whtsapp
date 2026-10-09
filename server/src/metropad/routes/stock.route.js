import { Router } from 'express'
import * as controller from '../controllers/stock.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/config', controller.getConfig)
router.put('/config', authorize('ADMIN'), controller.updateConfig)
router.get('/summary', authorize('ADMIN', 'OPERATOR'), controller.getStockSummary)
router.get('/stations', authorize('ADMIN', 'OPERATOR'), controller.getStationWiseStock)
router.get('/monthly', authorize('ADMIN', 'OPERATOR'), controller.getMonthlyStockReport)
router.post('/monthly/status', authorize('ADMIN', 'OPERATOR'), controller.setMonthlyRefillStatus)
router.put('/monthly/refill/:machineId', authorize('ADMIN', 'OPERATOR'), controller.saveMonthlyRefill)
router.get('/remaining', authorize('ADMIN', 'OPERATOR'), controller.getRemainingCentralStock)

export default router
