import { Router } from 'express'
import * as controller from '../controllers/cashCollection.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/', controller.getMonthly)
router.post('/', authorize('ADMIN', 'OPERATOR'), controller.create)
router.delete('/:id', authorize('ADMIN', 'OPERATOR'), controller.remove)

export default router