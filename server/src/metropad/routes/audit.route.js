import { Router } from 'express'
import * as controller from '../controllers/audit.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect, authorize('ADMIN'))

router.get('/', controller.getAll)

export default router