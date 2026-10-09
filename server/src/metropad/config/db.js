import { db, requireDb, isDbConfigured, normalizeError, notConfiguredError } from './supabase.js'

export const connectDB = async () => {
  try {
    await db.testConnection()
    console.log('MetroPad Care database connected successfully')
  } catch (err) {
    console.error('MetroPad Care database connection failed:', err.message)
    throw err
  }
}

export const query = async (text, params) => {
  const { rows } = await db._pool.query(text, params)
  return rows
}

export const getClient = async () => db._pool

export const isConfigured = isDbConfigured

export { requireDb, normalizeError, notConfiguredError }

export default db