import nodemailer from 'nodemailer'
import db from '../config/supabase.js'
import { sql } from '../../config/db.js'
import { AppError } from '../middleware/errorHandler.js'

// Ported from supabase/functions/send-membership-email (pure Deno SMTP) to
// nodemailer against the same Gmail account. All sends are logged to mail_log,
// preserving the edge function's semantics exactly, including its per-member
// sent/error result shape that the admin panel branches on.

// Credentials are intentionally hardcoded (team decision: no env vars for the
// Gmail user/password). Fill in the 16-character app password below to enable
// sends.
const GMAIL_USER = 'library.sevak@gmail.com'
const GMAIL_APP_PASSWORD = ''
const APP_URL = process.env.SEVAK_APP_URL || 'https://api.beingsevak.org/sevak-library'

const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
})

async function smtpSend(to, subject, html) {
  if (!GMAIL_APP_PASSWORD) {
    throw new AppError('Gmail app password is not configured - email not sent', 500)
  }
  await transport.sendMail({ from: `Sevak Library <${GMAIL_USER}>`, to, subject, html })
}

// ---------- Email builders (port of buildMembershipEmail / buildPaymentEmail /
// buildRenewalEmail / buildCouponEmail) ----------

const cardRow = (k, v) =>
  `<tr><td style="padding:8px;border:1px solid #dadce0">${k}</td><td style="padding:8px;border:1px solid #dadce0"><strong>${v}</strong></td></tr>`

const shell = (inner) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;border:1px solid #dadce0;border-top:4px solid #1a7f4b;border-radius:8px;overflow:hidden">
    <div style="background:#e8f5ee;padding:24px;text-align:center">
      <h1 style="color:#126138;margin:0;font-size:22px">Sevak Library</h1>
      <p style="color:#126138;margin:4px 0 0">Initiative by Being Sevak Charitable Trust</p>
    </div>
    <div style="padding:24px">${inner}</div>
    <div style="background:#f0f4f1;padding:16px;text-align:center;color:#5f6368;font-size:12px">
      Sevak Library | Being Sevak Charitable Trust
    </div>
  </div>
`

const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#1a7f4b;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;margin:8px 0">${label}</a>`

function buildMembershipEmail(app, subject) {
  const fee = app.membership_fee ? `Rs. ${app.membership_fee}` : '—'
  const html = shell(`
    <p>Dear <strong>${app.full_name ?? ''}</strong>,</p>
    <p>Congratulations! Your library membership has been approved. Here are your membership details:</p>
    <table style="border-collapse:collapse;width:100%;margin:16px 0">
      ${cardRow('Membership ID', app.membership_id ?? '')}
      ${cardRow('Membership Type', app.membership_type ?? '')}
      ${cardRow('Fee Paid', fee)}
      ${cardRow('Start Date', app.start_date ?? '')}
      ${cardRow('End Date', app.end_date ?? '')}
    </table>
    <p>Please carry a copy of this email or your Membership ID when you visit the library.</p>
    <p>Thank you for supporting the Vidhya Project. <strong>Turning Pages, Changing Lives.</strong></p>
  `)
  return { subject: subject || 'Your Sevak Library Membership ID', html }
}

const buildPaymentEmail = (app) => {
  const payUrl = `${APP_URL}/#/pay/${encodeURIComponent(app.ref ?? '')}`
  const html = shell(`
    <p>Dear <strong>${app.full_name ?? ''}</strong>,</p>
    <p>Thank you for applying to Sevak Library. Your application has been received, but your payment is still pending.</p>
    <table style="border-collapse:collapse;width:100%;margin:16px 0">
      ${cardRow('Application Reference', app.ref ?? '')}
      ${cardRow('Membership Type', app.membership_type ?? '')}
      ${cardRow('Start Date', app.start_date ?? '')}
      ${cardRow('End Date', app.end_date ?? '')}
    </table>
    <p>Click the button below to complete your payment:</p>
    <p style="text-align:center">${btn(payUrl, 'Complete my payment')}</p>
    <p style="color:#5f6368;font-size:12.5px">Or copy this link into your browser: <br><span style="color:#1a7f4b">${payUrl}</span></p>
    <p>If you have already paid, please ignore this email.</p>
  `)
  return { subject: 'Complete your Sevak Library membership payment', html }
}

const buildRenewalEmail = (app) => {
  const html = shell(`
    <p>Dear <strong>${app.full_name ?? ''}</strong>,</p>
    <p>Thank you for being a member of Sevak Library. Your membership period has now ended.</p>
    <table style="border-collapse:collapse;width:100%;margin:16px 0">
      ${cardRow('Membership ID', app.membership_id ?? '')}
      ${cardRow('Membership Type', app.membership_type ?? '')}
      ${cardRow('Previous Start Date', app.start_date ?? '')}
      ${cardRow('Previous End Date', app.end_date ?? '')}
    </table>
    <p>You can renew your membership by submitting a fresh application below. Turning Pages, Changing Lives — we would love to have you back.</p>
    <p style="text-align:center">${btn(APP_URL, 'Renew my membership')}</p>
    <p style="color:#5f6368;font-size:12.5px">Or copy this link into your browser: <br><span style="color:#1a7f4b">${APP_URL}</span></p>
  `)
  return { subject: 'Renew your Sevak Library membership', html }
}

const discountLabel = (coupon) => {
  if (!coupon) return 'a special discount'
  if (coupon.discount_type === 'flat') return `Rs. ${coupon.discount_value} off your membership fee`
  return `${coupon.discount_value}% off your membership fee`
}

const buildCouponEmail = (member, coupon) => {
  const validity = coupon?.valid_until
    ? `Valid until <strong>${coupon.valid_until}</strong>`
    : coupon?.valid_from
      ? `Valid from <strong>${coupon.valid_from}</strong>`
      : 'No expiry'
  const minFee = coupon?.min_fee ? `<p style="margin:4px 0 0;color:#5f6368;font-size:12.5px">Applies to membership fees of Rs. ${coupon.min_fee} or more.</p>` : ''
  const html = shell(`
    <p>Dear <strong>${member.full_name ?? ''}</strong>,</p>
    <p>As a valued member of Sevak Library, here is an exclusive discount coupon for you:</p>
    <div style="text-align:center;margin:20px 0">
      <div style="display:inline-block;border:2px dashed #1a7f4b;border-radius:12px;background:#e8f5ee;padding:18px 34px">
        <div style="font-size:12px;color:#126138;letter-spacing:1px;text-transform:uppercase;font-weight:600">Coupon code</div>
        <div style="font-size:28px;font-weight:800;color:#0b2f1e;letter-spacing:3px;margin-top:4px">${coupon?.code ?? ''}</div>
      </div>
    </div>
    <p style="text-align:center"><strong>${discountLabel(coupon)}</strong></p>
    ${minFee}
    <p style="text-align:center;color:#5f6368;font-size:12.5px">${validity}</p>
    <p>Share this code with our staff when you next join or renew your membership to apply the discount.</p>
    <p style="text-align:center">${btn(APP_URL, 'Visit Sevak Library')}</p>
    <p>Thank you for supporting the Vidhya Project. <strong>Turning Pages, Changing Lives.</strong></p>
  `)
  return { subject: 'Your Sevak Library discount coupon', html }
}

async function logMail({ applicationId, toEmail, subject, body, membershipId, sent, error }) {
  await sql(
    `INSERT INTO public.mail_log (application_id, to_email, subject, body, membership_id, sent, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [applicationId ?? null, toEmail ?? null, subject ?? null, body ?? null, membershipId ?? null, sent, error ?? null]
  )
}

async function fetchApplication(id) {
  const { data, error } = await db.from('applications').select('*').eq('id', id).single()
  if (error || data == null) throw new AppError(error?.message || 'Application not found', 404)
  return data
}

// type 'membership' requires an issued membership_id; 'payment' requires the
// application to still be SUBMITTED. Matches the edge function's guards.
export async function sendApplicationEmail(applicationId, type) {
  const isPayment = type === 'payment'
  const app = await fetchApplication(applicationId)

  if (!isPayment && !app.membership_id) throw new AppError('Membership ID has not been issued yet', 400)
  if (isPayment && app.status !== 'SUBMITTED') throw new AppError('Payment has already been submitted for this application', 400)

  const { subject, html } = isPayment ? buildPaymentEmail(app) : buildMembershipEmail(app)

  let sent = false
  let errMsg = null
  try {
    await smtpSend(app.email, subject, html)
    sent = true
  } catch (e) {
    errMsg = e && e.message ? e.message : String(e)
  }

  await logMail({ applicationId: app.id, toEmail: app.email, subject, body: html, membershipId: isPayment ? null : app.membership_id, sent, error: errMsg })

  return {
    ok: true,
    type: isPayment ? 'payment' : 'membership',
    sent,
    provider: 'gmail',
    error: errMsg,
    membershipId: isPayment ? null : app.membership_id,
    to: app.email,
  }
}

export async function sendCouponEmails(couponId, applicationIds) {
  if (!couponId) throw new AppError('couponId is required', 400)
  if (!Array.isArray(applicationIds) || applicationIds.length === 0) throw new AppError('No recipients selected', 400)

  const { data: coupon, error: couponErr } = await db.from('coupons').select('*').eq('id', couponId).single()
  if (couponErr || coupon == null) throw new AppError('Coupon not found', 404)
  if (!coupon.active) throw new AppError('Coupon is inactive', 400)
  if (coupon.valid_until && coupon.valid_until < new Date().toISOString().slice(0, 10)) {
    throw new AppError('Coupon has expired', 400)
  }

  const { data: members, error: membersErr } = await db.from('applications').select('*').in('id', applicationIds).eq('status', 'APPROVED')
  if (membersErr) throw new AppError(membersErr.message, 500)

  const results = []
  for (const member of members || []) {
    const { subject, html } = buildCouponEmail(member, coupon)
    let sent = false
    let errMsg = null
    try {
      await smtpSend(member.email, subject, html)
      sent = true
    } catch (e) {
      errMsg = e && e.message ? e.message : String(e)
    }
    await logMail({ applicationId: member.id, toEmail: member.email, subject, body: html, membershipId: member.membership_id ?? null, sent, error: errMsg })
    results.push({ id: member.id, email: member.email, sent, error: errMsg })
  }

  return { ok: true, mode: 'coupon', couponCode: coupon.code, results }
}

// Automatic one-off renewal reminder for APPROVED members whose end_date has
// passed and who have not yet received it. Mirrors the edge function's
// renewal_scan. Flags renewal_email_sent only on success.
export async function runRenewalScan() {
  const today = new Date().toISOString().slice(0, 10)
  const due = await sql(
    `SELECT id, ref, full_name, email, mobile, membership_id, membership_type, start_date, end_date
       FROM public.applications
      WHERE status = 'APPROVED' AND renewal_email_sent = false AND end_date <= $1`,
    [today]
  )

  const sentIds = []
  const failIds = []
  for (const app of due) {
    const { subject, html } = buildRenewalEmail(app)
    let sent = false
    let errMsg = null
    try {
      await smtpSend(app.email, subject, html)
      sent = true
    } catch (e) {
      errMsg = e && e.message ? e.message : String(e)
    }
    await logMail({ applicationId: app.id, toEmail: app.email, subject, body: html, membershipId: app.membership_id ?? null, sent, error: errMsg })

    if (sent) {
      sentIds.push(app.id)
      await sql(`UPDATE public.applications SET renewal_email_sent = true WHERE id = $1`, [app.id])
    } else {
      failIds.push(app.id)
    }
  }

  return { ok: true, mode: 'renewal_scan', processed: due.length, sentIds, failIds }
}