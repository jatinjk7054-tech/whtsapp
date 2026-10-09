import { Router } from 'express'
import * as controller from '../controllers/dashboard.controller.js'
import { protect } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/stats', controller.getStats)
router.get('/alerts/low-stock', controller.getLowStockAlerts)
router.get('/alerts/attention', controller.getAttentionMachines)
router.get('/recent-refills', controller.getRecentRefills)
router.get('/overview', controller.getOverview)

export default router
