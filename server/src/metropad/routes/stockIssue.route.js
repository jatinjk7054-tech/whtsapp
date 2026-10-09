import { Router } from 'express'
import * as controller from '../controllers/stockIssue.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/', controller.getAll)
router.get('/:id', controller.getById)
router.get('/machine/:machineId', controller.getByMachine)
router.post('/', authorize('ADMIN', 'OPERATOR'), controller.create)
router.patch('/:id/status', authorize('ADMIN', 'OPERATOR'), controller.updateStatus)

export default router
