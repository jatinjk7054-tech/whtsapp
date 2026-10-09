import { Router } from 'express'
import * as controller from '../controllers/user.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const router = Router()
router.use(protect, authorize('ADMIN'))

router.get('/', controller.getAll)
router.get('/:id', controller.getById)
router.post('/', controller.create)
router.put('/:id', controller.update)
router.patch('/:id/password', controller.resetPassword)
router.delete('/:id', controller.delete)

export default router