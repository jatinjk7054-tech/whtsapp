/**
 * Prompt + parsing for the Monthly Planner's activity-driven programme
 * suggestions.
 *
 * This is the planner's counterpart to the day-driven flow in
 * eventHeadController.suggestDayPrograms. Two deliberate differences:
 *
 *   1. It is ACTIVITY-anchored, not date-anchored. The activity is resolved
 *      server-side from an id, so the model never has to echo an activity id
 *      back ("aid"/"a" in the day flow). That removes the single biggest source
 *      of malformed output there, and means the model can never invent an
 *      activity that does not exist.
 *   2. It proposes NO dates. The planner assigns dates when the user turns a
 *      suggestion into a programme. Observances for the month are passed only
 *      as themes to build on, and any date-ish key the model invents is
 *      stripped on the way out.
 *
 * Kept dependency-free and side-effect-free so it can be unit tested without a
 * database or an AI key, matching the repo's existing pure-util test style.
 */

/** Six fits the shared ~950-token budget far better than the day flow's ten. */
export const ACTIVITY_SUGGESTION_LIMIT = 6;

/**
 * The one beneficiary group each NGO serves, by its short code.
 *
 * This is the single source of truth for the planner's beneficiary group: the
 * prompt, the monthly filter and the table column all read it rather than a
 * per-activity free-text tag, so an activity cannot claim a group its NGO does
 * not serve. Kept here, next to the prompt, so aiming the AI at the group and
 * filtering by it cannot drift apart.
 */
export const NGO_BENEFICIARY_GROUP = {
  bsct: 'Visually Impaired',
  aflf: 'Underprivileged Families',
  mann: 'Women',
};

/** '' for an unknown or missing code — the prompt then simply drops the line. */
export const beneficiaryGroupForNgo = (code) =>
  NGO_BENEFICIARY_GROUP[String(code || '').trim().toLowerCase()] || '';

/**
 * The closed vocabulary of groups, in a stable order.
 *
 * An activity stores the group it serves, so this is what an activity's own
 * value is matched against: trimmed and case-insensitive, and '' for anything
 * outside the three. A value outside the vocabulary must not reach the prompt —
 * it would aim the AI at a group nothing else in the system knows about, and it
 * could not be filtered on later.
 */
export const ACTIVITY_BENEFICIARY_GROUPS = Object.values(NGO_BENEFICIARY_GROUP);

/** The saved spelling of a group, or '' when it is not one of the three. */
export const canonicalActivityBeneficiary = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  return ACTIVITY_BENEFICIARY_GROUPS.find((g) => g.toLowerCase() === v) || '';
};

/** Same closed vocabulary the day flow uses, so both features stay consistent. */
export const ACTIVITY_PROGRAM_FORMATS = [
  'Health Camp',
  'Awareness Drive',
  'Distribution',
  'Workshop',
  'Celebration',
  'Screening Camp',
  'Training',
  'Community Meeting',
  'Sports / Cultural Event',
  'Fundraising / CSR Event',
];

export const ACTIVITY_PROGRAM_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MAX_TITLE_LEN = 120;
const MAX_AUDIENCE_LEN = 120;
const MAX_DURATION_LEN = 60;
const MAX_TEXT_LEN = 240;
const MAX_MATERIALS = 6;

/** 'YYYY-MM', with a real month number so '2026-13' is rejected. */
export const isMonthYmd = (value) =>
  /^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(value || '').trim());

/** '2026-10' -> 'October 2026'. Empty string when the month is not valid. */
export const monthLabel = (monthYmd) => {
  const m = String(monthYmd || '').trim();
  if (!isMonthYmd(m)) return '';
  const [y, mo] = m.split('-');
  return `${MONTH_NAMES[Number(mo) - 1]} ${y}`;
};

/** '2026-10' -> '2026-10-01', the inclusive first day. */
export const monthFirstDay = (monthYmd) => `${String(monthYmd).trim()}-01`;

/** '2026-10' -> '2026-11-01', the exclusive end used by getObservancesInRange. */
export const monthEndExclusive = (monthYmd) => {
  const m = String(monthYmd || '').trim();
  if (!isMonthYmd(m)) return '';
  const [y, mo] = m.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo, 1));
  return next.toISOString().slice(0, 10);
};

/* ── Prompt ──────────────────────────────────────────────────────────────── */

/**
 * Builds the prompt. Every field is optional except activityName, because the
 * controller has already validated the request before calling this.
 *
 * @param {object}  o
 * @param {string}  o.activityName  resolved from the DB, never client-supplied
 * @param {string=} o.ngoName
 * @param {string=} o.ngoCode       short code (BSCT / MANN / AFLF)
 * @param {string=} o.sectorName
 * @param {string=} o.beneficiaryGroup  who the activity serves
 * @param {string=} o.monthYmd      'YYYY-MM'
 * @param {Array=}  o.observances   [{ name, scope, kind }] for the month
 * @param {Array=}  o.existingTitles  programmes already planned this month
 * @param {number=} o.limit
 */
export function buildActivityProgramPrompt({
  activityName,
  ngoName = '',
  ngoCode = '',
  sectorName = '',
  beneficiaryGroup = '',
  monthYmd = '',
  observances = [],
  existingTitles = [],
  limit = ACTIVITY_SUGGESTION_LIMIT,
} = {}) {
  const activity = String(activityName || '').trim().slice(0, MAX_TITLE_LEN);
  const month = monthLabel(monthYmd) || 'the selected month';

  const occasionLines = (Array.isArray(observances) ? observances : [])
    .filter((o) => o && o.name)
    .slice(0, 25)
    .map((o) => `- ${String(o.name).slice(0, 90)}${o.kind ? ` (${o.scope || 'all'}/${o.kind})` : ''}`);

  const done = (Array.isArray(existingTitles) ? existingTitles : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 40);

  // The sample object omits any activity field on purpose: the activity is fixed
  // by the request, so asking the model to repeat it back only wastes the budget
  // and gives it a chance to disagree with us.
  const sample = `  { "t": "Word1 Word2 Word3 Word4 Word5", "f": "${ACTIVITY_PROGRAM_FORMATS[0]}", "p": "Medium", "u": "Five words here now", "d": "Half day", "o": "Ten words of objective text at most here.", "r": "Ten words of rationale text at most here.", "m": ["Two words","Three words"] }`;

  return [
    'You plan monthly programmes for a disability-focused Indian NGO. The activity is already chosen — suggest programmes for THAT activity only.',
    '',
    `The activity is: "${activity}". Every suggestion must be a programme of this activity. Do not drift into another activity.`,
    ngoName ? `The NGO is ${String(ngoName).slice(0, 120)}.` : '',
    ngoCode ? `Its code is ${String(ngoCode).slice(0, 24)}.` : '',
    sectorName ? `Its sector is: "${String(sectorName).slice(0, 120)}".` : '',
    beneficiaryGroup
      ? `This activity serves: "${String(beneficiaryGroup).slice(0, 120)}". Every programme must suit this group — its needs, its accessibility, and how this group is actually reached.`
      : '',
    `The planning month is ${month}. Do NOT output any date, day, month, year or "when" field — the planner assigns dates itself.`,
    '',
    occasionLines.length
      ? [
          `Observed occasions that fall inside ${month} (real dates, use them ONLY as themes to build on):`,
          ...occasionLines,
        ].join('\n')
      : `There is no registered occasion inside ${month}, so do NOT pretend there is one. Suggest genuinely useful programmes for an ordinary month.`,
    '',
    `HARD REQUIREMENT: the "suggestions" array must contain EXACTLY ${limit} objects. Count as you write: 1, 2, 3, ${Array.from({ length: Math.max(0, limit - 3) }, (_, i) => i + 4).join(', ')}. Never stop early. Never return fewer.`,
    `All ${limit} must be DIFFERENT programmes of the same activity. Vary the format, the audience and the objective between them.`,
    done.length ? `Do not repeat programmes this NGO already has planned: ${done.join('; ')}.` : '',
    '',
    `HARD TOKEN BUDGET: all ${limit} objects together share about 950 output tokens, so every field must be tiny. Verbose fields get the response cut mid-JSON. Word caps, strictly:`,
    't <= 5 words | u <= 5 words | o <= 10 words | r <= 10 words | m = exactly 2 items, each <= 3 words',
    'f and p must be copied verbatim from the lists below. No emoji. No markdown. No prose outside the JSON.',
    '',
    `f must be one of: ${ACTIVITY_PROGRAM_FORMATS.join(' | ')}`,
    `p must be one of: ${ACTIVITY_PROGRAM_PRIORITIES.join(' | ')}`,
    '',
    'Return ONLY a JSON object of this exact shape, no markdown, no commentary:',
    '{ "suggestions": [',
    sample,
    `  , then the same object repeated until there are exactly ${limit} of them, with no comma after the last one`,
    '] }',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── Parsing ─────────────────────────────────────────────────────────────── */

const DATEISH_KEY = /^(date|day|when|event_?date|scheduled_?on|year|month|day_?of_?week|weekday|datetime|time)$/i;

/** Exact match first, then a contains-match so 'SUPER-URGENT' becomes 'Urgent'. */
export function matchEnum(value, allowed, fallback) {
  const v = String(value ?? '').trim();
  if (!v) return fallback;
  const exact = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  const loose = allowed.find((a) => v.toLowerCase().includes(a.toLowerCase()));
  return loose || fallback;
}

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

function textField(raw, ...keys) {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null) return raw[k];
  }
  return '';
}

/**
 * Normalises one model object into the shape the client renders. Returns null
 * when there is no usable title, which is the only field we cannot do without.
 *
 * `activityName`/`activityId` are injected from the resolved DB row rather than
 * read off the model, so a suggestion can never claim a different activity.
 */
/* ── Festival/day-driven prompt (Monthly Planner Activities grid) ────────── */

/**
 * Builds the prompt for the Monthly Planner's festival-driven suggestions.
 *
 * Unlike buildActivityProgramPrompt this is NOT anchored to a single activity:
 * the unit of generation is (festival/day × NGO), and the NGO's beneficiary
 * group is resolved server-side and passed in — never typed by the user. The
 * model is asked for one concrete, useful programme per object, all for the
 * given occasion and audience.
 *
 * @param {object}  o
 * @param {string}  o.festivalName  the real festival/day (validated server-side)
 * @param {string=} o.dateLabel    human date, e.g. '14 November 2026'
 * @param {string=} o.ngoName
 * @param {string=} o.ngoCode       short code (BSCT / MANN / AFLF)
 * @param {string=} o.beneficiaryGroup  the NGO's group — auto, never manual
 * @param {string=} o.sectorName
 * @param {string=} o.monthYmd      'YYYY-MM'
 * @param {Array=}  o.existingTitles  programmes already planned this month
 * @param {number=} o.limit
 */
export function buildFestivalProgramPrompt({
  festivalName,
  dateLabel = '',
  ngoName = '',
  ngoCode = '',
  beneficiaryGroup = '',
  sectorName = '',
  monthYmd = '',
  existingTitles = [],
  limit = ACTIVITY_SUGGESTION_LIMIT,
} = {}) {
  const festival = String(festivalName || '').trim().slice(0, MAX_TITLE_LEN);
  const when = dateLabel ? String(dateLabel).slice(0, 60) : monthLabel(monthYmd) || 'the selected occasion';

  const done = (Array.isArray(existingTitles) ? existingTitles : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 40);

  const sample = `  { "t": "Word1 Word2 Word3 Word4 Word5", "f": "${ACTIVITY_PROGRAM_FORMATS[0]}", "p": "Medium", "u": "Five words here now", "d": "Half day", "o": "Ten words of objective text at most here.", "r": "Ten words of rationale text at most here.", "m": ["Two words","Three words"] }`;

  return [
    'You plan aware, community-driven programmes for a disability-focused Indian NGO, centred on one real festival/important day.',
    '',
    `The occasion is: "${festival}", falling on ${when}.`,
    'Anchor every suggestion to this occasion — its meaning and its themes. Do NOT drift into generic routine programmes.',
    ngoName ? `The NGO is ${String(ngoName).slice(0, 120)}.` : '',
    ngoCode ? `Its code is ${String(ngoCode).slice(0, 24)}.` : '',
    sectorName ? `Its sector of work is: "${String(sectorName).slice(0, 120)}".` : '',
    beneficiaryGroup
      ? `The beneficiary group is: "${String(beneficiaryGroup).slice(0, 120)}". Every programme must suit THIS group — its needs, its accessibility, and how this group is actually reached. Do not invent other beneficiary groups.`
      : 'No specific beneficiary group is configured — keep the programmes broadly accessible.',
    'Do NOT output any date, day, month, year or "when" field — the planner assigns dates itself.',
    '',
    `HARD REQUIREMENT: the "suggestions" array must contain EXACTLY ${limit} objects. Count as you write: 1, 2, 3, ${Array.from({ length: Math.max(0, limit - 3) }, (_, i) => i + 4).join(', ')}. Never stop early. Never return fewer.`,
    `All ${limit} must be DIFFERENT programmes. Vary the format, the audience and the objective between them.`,
    done.length ? `Do not repeat programmes this NGO already has planned: ${done.join('; ')}.` : '',
    '',
    `HARD TOKEN BUDGET: all ${limit} objects together share about 950 output tokens, so every field must be tiny. Verbose fields get the response cut mid-JSON. Word caps, strictly:`,
    't <= 5 words | u <= 5 words | o <= 10 words | r <= 10 words | m = exactly 2 items, each <= 3 words',
    'f and p must be copied verbatim from the lists below. No emoji. No markdown. No prose outside the JSON.',
    '',
    `f must be one of: ${ACTIVITY_PROGRAM_FORMATS.join(' | ')}`,
    `p must be one of: ${ACTIVITY_PROGRAM_PRIORITIES.join(' | ')}`,
    '',
    'Return ONLY a JSON object of this exact shape, no markdown, no commentary:',
    '{ "suggestions": [',
    sample,
    `  , then the same object repeated until there are exactly ${limit} of them, with no comma after the last one`,
    '] }',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Pulls the suggestions array out of the provider output and normalises it,
 * de-duplicating by title and capping at `limit`. No activity stamp is applied:
 * these rows belong to a festival + NGO, not to one activity.
 */
export function parseFestivalProgramSuggestions(parsed, {
  existingTitles = [],
  limit = ACTIVITY_SUGGESTION_LIMIT,
} = {}) {
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.suggestions)
      ? parsed.suggestions
      : [];

  const seen = new Set(
    (Array.isArray(existingTitles) ? existingTitles : [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean),
  );

  const out = [];
  for (const raw of list) {
    const s = normalizeActivitySuggestion(raw, {});
    if (!s) continue;
    const key = s.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export function normalizeActivitySuggestion(raw, { activityName = '', activityId = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  // Drop anything date-like the model volunteered. The planner owns dates.
  for (const key of Object.keys(raw)) {
    if (DATEISH_KEY.test(key)) delete raw[key];
  }

  // Models like to number their output ("1. Basic Course"), so strip the
  // numbering before the length cap rather than letting it eat the budget.
  const title = clip(
    String(textField(raw, 'title', 'name', 't')).replace(/^[\d.\-)\s]+/, ''),
    MAX_TITLE_LEN,
  );
  if (!title) return null;

  const materials = textField(raw, 'materials', 'm');
  const materialList = Array.isArray(materials)
    ? materials.map((x) => clip(x, 60)).filter(Boolean).slice(0, MAX_MATERIALS)
    : [];

  return {
    title,
    // Stamped from the resolved DB row, never read off the model.
    activityId: activityId ?? null,
    activityName: clip(activityName, MAX_TITLE_LEN),
    format: matchEnum(textField(raw, 'format', 'f'), ACTIVITY_PROGRAM_FORMATS, ''),
    priority: matchEnum(textField(raw, 'priority', 'p'), ACTIVITY_PROGRAM_PRIORITIES, 'Medium'),
    audience: clip(textField(raw, 'audience', 'beneficiaries', 'u'), MAX_AUDIENCE_LEN),
    duration: clip(textField(raw, 'duration', 'd'), MAX_DURATION_LEN),
    objective: clip(textField(raw, 'objective', 'aim', 'goal', 'o'), MAX_TEXT_LEN),
    rationale: clip(textField(raw, 'rationale', 'why', 'reason', 'r'), MAX_TEXT_LEN),
    materials: materialList,
    // Explicitly null so the client can never mistake a suggestion for a
    // scheduled event, and never render a date the model made up.
    date: null,
  };
}

/**
 * Pulls the suggestions array out of whatever the provider returned and
 * normalises it, de-duplicating by title and capping at `limit`.
 *
 * `truncated` is passed through from the provider layer: it means the response
 * hit its token ceiling, so whatever arrived is usable but may not be every
 * idea that exists.
 *
 * @param {object} parsed  the parsed provider output (array or { suggestions })
 * @param {object} opts    { activityName, activityId, existingTitles, limit }
 */
export function parseActivityProgramSuggestions(parsed, {
  activityName = '',
  activityId = null,
  existingTitles = [],
  limit = ACTIVITY_SUGGESTION_LIMIT,
} = {}) {
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.suggestions)
      ? parsed.suggestions
      : [];

  const seen = new Set(
    (Array.isArray(existingTitles) ? existingTitles : [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean),
  );

  const out = [];
  for (const raw of list) {
    const s = normalizeActivitySuggestion(raw, { activityName, activityId });
    if (!s) continue;
    const key = s.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}