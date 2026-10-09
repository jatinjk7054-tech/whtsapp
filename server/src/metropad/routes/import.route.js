import { Router } from 'express'
import multer from 'multer'
import * as controller from '../controllers/import.controller.js'
import { protect, authorize } from '../middleware/auth.js'

const storage = multer.memoryStorage()
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv'
  ]
  if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(xlsx?|csv)$/i)) {
    cb(null, true)
  } else {
    cb(new Error('Only .xlsx, .xls, .csv files are allowed'))
  }
}

const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter })

const router = Router()
router.use(protect)
router.post('/validate', upload.single('file'), controller.validateFile)
router.post('/confirm', authorize('ADMIN', 'OPERATOR'), controller.confirmImport)

export default router
