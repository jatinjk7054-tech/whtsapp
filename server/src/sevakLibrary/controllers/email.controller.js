import * as emailService from '../services/email.service.js'

export const sendMembershipEmail = async (req, res, next) => {
  try {
    const result = await emailService.sendApplicationEmail(req.params.id, 'membership')
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const sendPaymentReminder = async (req, res, next) => {
  try {
    const result = await emailService.sendApplicationEmail(req.params.id, 'payment')
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const sendCouponEmail = async (req, res, next) => {
  try {
    const result = await emailService.sendCouponEmails(req.body.couponId, req.body.applicationIds)
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}