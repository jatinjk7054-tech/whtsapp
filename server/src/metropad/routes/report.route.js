import { Router } from 'express'
import * as controller from '../controllers/report.controller.js'
import { protect } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/station', controller.getStationReport)
router.get('/machine', controller.getMachineReport)
router.get('/metro-line', controller.getMetroLineReport)
router.get('/monthly', controller.getMonthlyReport)
router.get('/refills', controller.getRefillReport)
router.get('/export/:type', controller.exportReport)

export default router
