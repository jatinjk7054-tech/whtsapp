// Shared lookup that normalizes a Mode-of-Payment (MOP) string to a clean
// display label. Used by the AI payment scraper ingest (paymentScraperService)
// and the accounts/fund-collection reporting (accountsController) so a single
// source of truth controls casing ("Google Pay", "UPI", "Paytm", …) no matter
// the case the raw value arrives in.

export const MODE_LABELS = {
  upi: 'UPI',
  pum: 'PUM',
  'icici bank': 'ICICI Bank',
  icici: 'ICICI Bank',
  'google pay': 'Google Pay',
  googlepay: 'Google Pay',
  razorpay: 'Razorpay',
  'razor pay': 'Razorpay',
  paytm: 'Paytm',
  freecharge: 'Freecharge',
  cheque: 'Cheque',
  online: 'Online',
  'saraswat bank': 'Saraswat Bank',
};

const titleCase = (raw) =>
  raw.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

export function formatModeLabel(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  return MODE_LABELS[key] || titleCase(raw);
}
