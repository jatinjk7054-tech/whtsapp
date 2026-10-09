import db from '../config/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

const ensureRow = (result, message) => {
  if (result.error || result.data == null) throw new AppError(message || 'Coupon not found', result.error?.code === '23505' ? 409 : 404)
  return result.data
}

export async function listCoupons() {
  const { data, error } = await db.from('coupons').select('*').order('created_at', { ascending: false })
  if (error) throw new AppError(error.message, 500)
  return data
}

export async function createCoupon(values) {
  const { data, error } = await db.from('coupons').insert(values).select().single()
  return ensureRow({ data, error }, 'Could not create coupon')
}

export async function updateCoupon(id, values) {
  const { data, error } = await db.from('coupons').update(values).eq('id', id).select().single()
  return ensureRow({ data, error })
}

export async function deleteCoupon(id) {
  const { error } = await db.from('coupons').delete().eq('id', id).select()
  if (error) throw new AppError(error.message, 500)
}

export async function getCoupon(id) {
  const { data, error } = await db.from('coupons').select('*').eq('id', id).single()
  return ensureRow({ data, error })
}