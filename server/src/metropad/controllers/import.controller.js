import * as importService from '../services/import.service.js'

export const validateFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' })
    }
    const result = await importService.validateImport(req.file.buffer, req.file.originalname)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const confirmImport = async (req, res, next) => {
  try {
    const { rows } = req.body
    const result = await importService.confirmImport(rows, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}
