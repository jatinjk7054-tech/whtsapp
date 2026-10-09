import { requireDb, normalizeError } from '../config/supabase.js'

const USER_SELECT = 'id, name, email, role, is_active, created_at'

const safeGetSingle = async (builder) => {
  const { data, error } = await builder.maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const findUserByEmail = async (email) => {
  return safeGetSingle(requireDb().from('metropad_users').select('*').eq('email', email))
}

export const findUserById = async (id) => {
  return safeGetSingle(requireDb().from('metropad_users').select(USER_SELECT).eq('id', id))
}

export const getAllUsers = async ({ page = 1, limit = 20, search = '' } = {}) => {
  const from = (page - 1) * limit
  const to = from + limit - 1
  const p = Math.max(1, Number(page) || 1)
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))

  let query = requireDb().from('metropad_users').select(USER_SELECT, { count: 'exact' })
  if (search) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
  }
  query = query.order('created_at', { ascending: false }).range(from, to)

  const { data, error, count } = await query
  if (error) throw normalizeError(error)

  return {
    users: data,
    meta: {
      page: p,
      limit: lim,
      total: count,
      totalPages: Math.ceil(count / lim),
    },
  }
}

export const createUser = async ({ name, email, passwordHash, role }) => {
  const { data, error } = await requireDb()
    .from('metropad_users')
    .insert({ name, email, password_hash: passwordHash, role })
    .select('id, name, email, role')
    .single()
  if (error) throw normalizeError(error)
  return data
}

export const updateUser = async (id, { name, email, role, isActive } = {}) => {
  const updates = { updated_at: new Date().toISOString() }
  if (name !== undefined) updates.name = name
  if (email !== undefined) updates.email = email
  if (role !== undefined) updates.role = role
  if (isActive !== undefined) updates.is_active = isActive

  const { data, error } = await requireDb()
    .from('metropad_users')
    .update(updates)
    .eq('id', id)
    .select('id, name, email, role, is_active')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data || (await findUserById(id))
}

export const updateUserPassword = async (id, passwordHash) => {
  const { data, error } = await requireDb()
    .from('metropad_users')
    .update({ password_hash: passwordHash, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, email, role, is_active')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}

export const removeUser = async (id) => {
  const { data, error } = await requireDb()
    .from('metropad_users')
    .delete()
    .eq('id', id)
    .select('id, name, email, role')
    .maybeSingle()
  if (error) throw normalizeError(error)
  return data
}