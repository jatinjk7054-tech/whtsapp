import express from 'express'
import db from '../config/db.js'
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js'

const router = express.Router()

const DATE_FIELDS = ['purchase_date', 'warranty_expiry', 'assigned_date', 'repair_date']
const NUM_FIELDS = ['purchase_price', 'sim_plan', 'repair_cost', 'total_repair_cost', 'quantity']

const adminHrAccounts = authenticateRole('super_admin', 'admin', 'hr', 'accounts')

function sanitize(body) {
  const b = { ...body }
  delete b.id
  delete b.created_at
  DATE_FIELDS.forEach(k => { if (b[k] === '' || b[k] === undefined) delete b[k]; if (b[k] === null) b[k] = null })
  NUM_FIELDS.forEach(k => { if (b[k] === '') b[k] = null })
  // Quantity lines (Android/Nokia and all other non-machine categories) have no
  // asset code. Store NULL so multiple rows pass the UNIQUE index on (code);
  // an empty string would collide on the second insert. POST / still auto-codes
  // when code is falsy via nextCode().
  if (b.code === '' || b.code === undefined) b.code = null
  return b
}

async function nextCode() {
  const { data } = await db.from('assets').select('code')
  const max = (data || []).reduce((m, r) => {
    const n = parseInt(String(r.code || '').replace(/\D/g, ''), 10)
    return isNaN(n) ? m : Math.max(m, n)
  }, 0)
  return `AST-${String(max + 1).padStart(3, '0')}`
}

router.get('/', adminHrAccounts, async (req, res) => {
  const { data, error } = await db
    .from('assets')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get assets assigned to the currently logged-in worker (for ticket auto-fill)
router.get('/my-assigned', authenticate, async (req, res) => {
  try {
    const { data, error } = await db
      .from('assets')
      .select('id, code, name, category, location, assigned_to, assigned_to_name, assigned_date')
      .eq('assigned_to', req.user.id)
      .eq('status', 'assigned')
      .order('assigned_date', { ascending: false })
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/:id', adminHrAccounts, async (req, res) => {
  const { data, error } = await db
    .from('assets')
    .select('*')
    .eq('id', req.params.id)
    .single()
  if (error) return res.status(404).json({ error: 'Asset not found' })
  res.json(data)
})

router.post('/', adminHrAccounts, async (req, res) => {
  const body = sanitize(req.body)

  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Asset name is required' })
  }

  if (!body.code) body.code = await nextCode()

  if (!Array.isArray(body.history) || body.history.length === 0) {
    body.history = [{ date: new Date().toISOString().slice(0, 10), text: 'Asset registered' }]
  }
  if (!body.status) body.status = 'available'

  const { data, error } = await db
    .from('assets')
    .insert(body)
    .select()
    .single()

  if (error) {
    if (String(error.message).includes('duplicate')) {
      body.code = await nextCode()
      const retry = await db.from('assets').insert(body).select().single()
      if (retry.error) return res.status(500).json({ error: retry.error.message })
      return res.status(201).json(retry.data)
    }
    return res.status(500).json({ error: error.message })
  }
  res.status(201).json(data)
})

router.put('/:id', adminHrAccounts, async (req, res) => {
  const changes = sanitize(req.body)
  changes.updated_at = new Date().toISOString()

  const { data, error } = await db
    .from('assets')
    .update(changes)
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.delete('/:id', adminHrAccounts, async (req, res) => {
  const { error } = await db.from('assets').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ deleted: true })
})

// Bulk import from the Office Asset Register Excel:
//   machines (Desktop/Laptop) dedupe by `code` (DESK-1 (AFLF) ...)
//   quantity lines (all other categories) dedupe by category + location + name
//   ?upsert=true — when a duplicate is found, merge spec fields into existing row
router.post('/import', adminHrAccounts, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  const upsert = req.query.upsert === 'true'
  if (rows.length === 0) return res.status(400).json({ error: 'rows[] required' })

  const errors = []
  const inserted = []
  const updated = []
  const skipped = []

  const MERGE_FIELDS = [
    'name', 'category', 'location', 'quantity', 'team_leader', 'owner_name', 'company',
    'brand', 'model', 'serial_no', 'storage', 'ram', 'processor', 'motherboard',
    'condition', 'status', 'assigned_to_name', 'purchase_date', 'purchase_price',
    'warranty_expiry', 'sim_number', 'remarks',
  ]

  for (const raw of rows) {
    const row = sanitize(raw)
    if (!row.name || !String(row.name).trim()) {
      errors.push({ index: errors.length + inserted.length + updated.length + skipped.length + 1, error: 'Missing name' })
      continue
    }
    if (!row.quantity || Number(row.quantity) < 1) row.quantity = 1
    if (!row.status) row.status = 'available'
    if (!Array.isArray(row.history) || row.history.length === 0) {
      row.history = [{ date: new Date().toISOString().slice(0, 10), text: 'Imported from Office Asset Register' }]
    }

    let dupQuery = db.from('assets').select('id')
    if (row.code) {
      dupQuery = dupQuery.eq('code', row.code)
    } else {
      dupQuery = dupQuery.eq('category', row.category).eq('name', row.name)
      if (row.location) dupQuery = dupQuery.eq('location', row.location)
      else dupQuery = dupQuery.is('location', null)
    }
    const { data: existing } = await dupQuery.limit(1)
    if (existing && existing.length > 0) {
      if (upsert) {
        const updates = {}
        for (const f of MERGE_FIELDS) {
          const v = row[f]
          if (v !== '' && v !== null && v !== undefined) updates[f] = v
        }
        if (Object.keys(updates).length > 0) {
          updates.updated_at = new Date().toISOString()
          const { error: updErr } = await db.from('assets').update(updates).eq('id', existing[0].id)
          if (updErr) {
            errors.push({ code: row.code || row.name, error: updErr.message })
          } else {
            updated.push({ code: row.code || row.name, fields: Object.keys(updates) })
          }
        } else {
          skipped.push({ code: row.code || row.name, reason: 'No new data' })
        }
      } else {
        skipped.push({ code: row.code || `${row.category} / ${row.name}`, reason: 'Already exists' })
      }
      continue
    }

    const { data, error } = await db.from('assets').insert(row).select().single()
    if (error) {
      if (String(error.message).includes('duplicate')) {
        skipped.push({ code: row.code || `${row.category} / ${row.name}`, reason: 'Already exists' })
      } else {
        errors.push({ index: errors.length + inserted.length + updated.length + skipped.length + 1, error: error.message })
      }
      continue
    }
    inserted.push(data)
  }

  res.status(201).json({ inserted: inserted.length, updated: updated.length, skipped, errors, total: inserted.length + updated.length + skipped.length + errors.length })
})

export default router
