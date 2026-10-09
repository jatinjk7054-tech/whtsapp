// Shared lead attribution + conversion rules.
//
// The recruiter UI writes `selected` (STAGE_TO_STATUS maps the Selected stage to
// it) while the candidates pipeline and older rows use `joined`, and an offer that
// was accepted lands on `offer_accepted`/`onboarding`. Counting a single one of
// those vocabularies pins the success rate at zero, so every reader has to agree
// on the whole "won" set rather than picking a status by hand.

export const CONVERTED_STATUSES = ['selected', 'joined', 'offer_accepted', 'onboarding'];

// `not_interested` is the recruiter turning a candidate down under a different
// label from `rejected`, so the two are counted together as losses.
export const REJECTED_STATUSES = ['rejected', 'not_interested'];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

export const isConvertedStatus = (status) => CONVERTED_STATUSES.includes(norm(status));

export const isRejectedStatus = (status) => REJECTED_STATUSES.includes(norm(status));

// A lead belongs to a recruiter when it is assigned to them (recruiter_id), when
// they entered it (created_by), or — for the rows that only ever kept a display
// name — when either *_by_name stamp matches. A good share of leads carry no id
// at all, so id equality alone silently drops them from every leaderboard.
// Mirrors belongsToLead() in client/src/utils/leads.js; keep the two in step.
export const leadBelongsTo = (lead, recruiter) => {
  if (!lead || !recruiter) return false;
  const rid = String(recruiter.id);
  if (lead.recruiter_id && String(lead.recruiter_id) === rid) return true;
  if (lead.created_by && String(lead.created_by) === rid) return true;
  const name = norm(recruiter.name);
  if (!name) return false;
  return [lead.created_by_name, lead.scheduled_by_name].some((n) => norm(n) === name);
};

export const countConverted = (leads) => (leads || []).filter((l) => isConvertedStatus(l.status)).length;

export const countRejected = (leads) => (leads || []).filter((l) => isRejectedStatus(l.status)).length;

// Converted / (converted + lost). Undecided leads are excluded from the
// denominator, so a healthy pipeline that is still early does not read as a
// failure. Returns 0 when nothing has been decided yet.
export const conversionRate = (leads) => {
  const converted = countConverted(leads);
  const decided = converted + countRejected(leads);
  return decided > 0 ? Number(((converted / decided) * 100).toFixed(1)) : 0;
};