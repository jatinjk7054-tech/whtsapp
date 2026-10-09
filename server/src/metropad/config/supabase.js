import db from '../../config/db.js'
import { AppError } from '../middleware/errorHandler.js'

// The UCS_CRM backend exposes a Supabase-API-compatible query builder backed by
// plain PostgreSQL (pg). MetroPadCare models use only that API surface
// (db.from(...).select/eq/in/or/ilike/order/single/maybeSingle/insert/update/
// upsert/delete), so this shim re-exports the existing client — no Supabase.
export { db }

export const isDbConfigured = () => true

export const normalizeError = (err) => {
  if (!err) return err
  const base = new Error(err.message || 'Database request failed')
  base.code = err.code || undefined
  base.statusCode = err.status || Number(err.code) || undefined
  base.isOperational = true
  return base
}

export const notConfiguredError = () => {
  const err = new Error(
    'Database is not configured. Add DATABASE_URL to backend/.env.'
  )
  err.statusCode = 500
  err.isOperational = true
  return err
}

export const requireDb = () => db

export const createAppError = (message, statusCode) => new AppError(message, statusCode)