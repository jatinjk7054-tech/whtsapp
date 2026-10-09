import express from 'express'
import { errorHandler } from './middleware/errorHandler.js'
import authRoutes from './routes/auth.route.js'
import metroLineRoutes from './routes/metroLine.route.js'
import stationRoutes from './routes/station.route.js'
import machineRoutes from './routes/machine.route.js'
import refillRoutes from './routes/refill.route.js'
import stockIssueRoutes from './routes/stockIssue.route.js'
import maintenanceRoutes from './routes/maintenance.route.js'
import dashboardRoutes from './routes/dashboard.route.js'
import monthlyDataRoutes from './routes/monthlyData.route.js'
import reportRoutes from './routes/report.route.js'
import cashCollectionRoutes from './routes/cashCollection.route.js'
import stockRoutes from './routes/stock.route.js'
import importRoutes from './routes/import.route.js'
import userRoutes from './routes/user.route.js'
import auditRoutes from './routes/audit.route.js'

const createApiRouter = () => {
  const api = express.Router()

  api.get('/', (req, res) => {
    res.json({ success: true, message: 'MetroPad Care API. Health check: /api/metropad/health' })
  })

  api.get('/health', (req, res) => {
    res.json({ success: true, message: 'MetroPad Care backend is running' })
  })

  api.use('/auth', authRoutes)
  api.use('/metro-lines', metroLineRoutes)
  api.use('/stations', stationRoutes)
  api.use('/machines', machineRoutes)
  api.use('/refills', refillRoutes)
  api.use('/stock-issues', stockIssueRoutes)
  api.use('/maintenance', maintenanceRoutes)
  api.use('/dashboard', dashboardRoutes)
  api.use('/monthly-data', monthlyDataRoutes)
  api.use('/reports', reportRoutes)
  api.use('/cash-collections', cashCollectionRoutes)
  api.use('/stock', stockRoutes)
  api.use('/import', importRoutes)
  api.use('/users', userRoutes)
  api.use('/audit-logs', auditRoutes)

  api.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' })
  })

  api.use(errorHandler)

  return api
}

export default createApiRouter()