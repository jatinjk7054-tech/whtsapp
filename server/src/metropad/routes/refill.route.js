import { Router } from 'express'
import * as controller from '../controllers/refill.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect)

router.get('/', controller.getAll)
router.get('/recent', controller.getRecent)
router.get('/machine/:machineId', controller.getByMachine)
router.post('/', authorize('ADMIN', 'OPERATOR', 'VIEWER'), controller.create)
router.put('/:id', authorize('ADMIN', 'OPERATOR'), controller.update)
router.delete('/:id', authorize('ADMIN', 'OPERATOR'), controller.remove)

export default router
