import express from 'express'
import apiRouter from './routes/router.js'
import { errorHandler } from './middleware/errorHandler.js'

const createRouter = () => {
  const app = express.Router()

  app.get('/', (req, res) => {
    res.json({ success: true, message: 'Sevak Library API. Health check: /api/sevak-library/health' })
  })

  app.use('/', apiRouter)

  app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' })
  })

  app.use(errorHandler)

  return app
}

export default createRouter()