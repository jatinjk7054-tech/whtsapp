import * as couponService from '../services/coupon.service.js'

export const list = async (req, res, next) => {
  try {
    res.json({ success: true, data: await couponService.listCoupons() })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await couponService.createCoupon(req.body) })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    res.json({ success: true, data: await couponService.updateCoupon(req.params.id, req.body) })
  } catch (err) {
    next(err)
  }
}

export const remove = async (req, res, next) => {
  try {
    await couponService.deleteCoupon(req.params.id)
    res.json({ success: true, message: 'Coupon deleted' })
  } catch (err) {
    next(err)
  }
}