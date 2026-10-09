import { Router } from 'express'
import { authenticate } from '../../middleware/authMiddleware.js'
import { applicationPhotos } from '../middleware/upload.js'
import * as c from '../controllers/application.controller.js'
import * as emailC from '../controllers/email.controller.js'
import * as couponC from '../controllers/coupon.controller.js'

const router = Router()

// ── Public (no auth) ───────────────────────────────────────────────────
// Matches the original Supabase surface: anyone can submit, look up their own
// reference, record a payment and receive a payment reminder. The membership
// email (which exposes Membership IDs) requires the CRM session below.

router.get('/health', (req, res) => {
  res.json({ success: true, message: 'Sevak Library backend is running' })
})

router.post('/applications', applicationPhotos.fields([{ name: 'passport', maxCount: 1 }, { name: 'identity', maxCount: 1 }]), c.submit)
router.get('/applications/by-ref/:ref', c.getByRef)
router.post('/applications/record-payment', c.recordPayment)
router.post('/applications/:id/emails/payment-reminder', emailC.sendPaymentReminder)

// ── Admin (CRM session) ────────────────────────────────────────────────
router.use(authenticate)

router.get('/dashboard', c.dashboard)
router.get('/applications', c.list)
router.get('/applications/export', c.exportCsv)
router.get('/applications/mail-log', c.mailLog)
router.get('/applications/:id', c.getById)
router.get('/applications/:id/photo-url', c.photoUrl)
router.put('/applications/:id', applicationPhotos.fields([{ name: 'passport', maxCount: 1 }, { name: 'identity', maxCount: 1 }]), c.update)
router.delete('/applications/:id', c.remove)
router.post('/applications/:id/verify', c.verify)
router.post('/applications/:id/approve', c.approve)
router.post('/applications/:id/reject', c.reject)
router.post('/applications/:id/emails/membership', emailC.sendMembershipEmail)
router.post('/applications/import', c.importMembers)

router.get('/coupons', couponC.list)
router.post('/coupons', couponC.create)
router.put('/coupons/:id', couponC.update)
router.delete('/coupons/:id', couponC.remove)
router.post('/coupons/:id/email', emailC.sendCouponEmail)

export default router