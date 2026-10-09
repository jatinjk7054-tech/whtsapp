// CSV export of applications — same columns/serialization as the original
// admin panel's exportApplicationsCsv.

const HEADERS = [
  'Reference', 'Status', 'Membership ID', 'Full Name', 'Email', 'Mobile',
  'Plan', 'Fee', 'Start Date', 'End Date', 'Identity Proof', 'Identity Number',
  'Transaction ID', 'Created At',
]

const esc = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function applicationsCsv(rows) {
  const lines = [HEADERS.join(',')]
  for (const r of rows) {
    lines.push([
      r.ref, r.status, r.membership_id, r.full_name, r.email, r.mobile,
      r.membership_type, r.membership_fee, r.start_date, r.end_date,
      r.identity_proof_type, r.identity_number, r.transaction_id, r.created_at,
    ].map(esc).join(','))
  }
  return lines.join('\n')
}