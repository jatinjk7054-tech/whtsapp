import { Router } from 'express'
import * as controller from '../controllers/monthlyData.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/', controller.getMonthlyData)
router.get('/records', controller.getMonthlyRecords)
router.post('/records', authorize('ADMIN', 'OPERATOR'), controller.createMonthlyRecord)

export default router