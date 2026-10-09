import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_BENEFICIARY_GROUPS,
  ACTIVITY_SUGGESTION_LIMIT,
  buildActivityProgramPrompt,
  canonicalActivityBeneficiary,
  isMonthYmd,
  matchEnum,
  monthEndExclusive,
  monthFirstDay,
  monthLabel,
  normalizeActivitySuggestion,
  parseActivityProgramSuggestions,
} from './activityProgramPrompt.js';

const ctx = {
  ngoName: 'Being Sevak',
  sectorName: 'Technology & Assistive Devices',
  monthYmd: '2026-10',
  activityName: 'Computer Literacy Training',
};

/* ── Month helpers ───────────────────────────────────────────────────────── */

test('isMonthYmd accepts a real month and rejects bad ones', () => {
  assert.equal(isMonthYmd('2026-10'), true);
  assert.equal(isMonthYmd('2026-01'), true);
  assert.equal(isMonthYmd('2026-12'), true);
  assert.equal(isMonthYmd('2026-13'), false);
  assert.equal(isMonthYmd('2026-00'), false);
  assert.equal(isMonthYmd('2026-1'), false);
  assert.equal(isMonthYmd('2026-10-01'), false);
  assert.equal(isMonthYmd(''), false);
  assert.equal(isMonthYmd(null), false);
});

test('month range helpers return an inclusive/exclusive pair the observance range accepts', () => {
  assert.equal(monthFirstDay('2026-10'), '2026-10-01');
  assert.equal(monthEndExclusive('2026-10'), '2026-11-01');
  assert.equal(monthEndExclusive('2026-12'), '2027-01-01');
  // December must roll the year rather than produce month 13.
  assert.notEqual(monthEndExclusive('2026-12'), '2026-13-01');
  assert.equal(monthEndExclusive('nope'), '');
});

test('monthLabel spells the month', () => {
  assert.equal(monthLabel('2026-10'), 'October 2026');
  assert.equal(monthLabel('2026-01'), 'January 2026');
  assert.equal(monthLabel('2026-13'), '');
});

/* ── Prompt ──────────────────────────────────────────────────────────────── */

test('prompt names the activity and forbids date output', () => {
  const p = buildActivityProgramPrompt(ctx);
  assert.match(p, /Computer Literacy Training/);
  assert.match(p, /Being Sevak/);
  assert.match(p, /Technology & Assistive Devices/);
  assert.match(p, /October 2026/);
  assert.match(p, /do NOT output any date/i);
});

test('prompt never asks the model for an activity id', () => {
  // The activity is resolved server-side; asking for it back is the main source
  // of bad output in the day-driven flow.
  const p = buildActivityProgramPrompt(ctx);
  assert.doesNotMatch(p, /"aid"/);
  assert.doesNotMatch(p, /activity_options/);
});

test('prompt demands exactly the limit and lists the closed enums', () => {
  const p = buildActivityProgramPrompt(ctx);
  assert.match(p, new RegExp(`EXACTLY ${ACTIVITY_SUGGESTION_LIMIT} objects`));
  assert.match(p, /Count as you write: 1, 2, 3, 4, 5, 6\./);
  assert.match(p, new RegExp(`exactly ${ACTIVITY_SUGGESTION_LIMIT} of them`));
  assert.match(p, /Health Camp \| Awareness Drive/);
  assert.match(p, /Low \| Medium \| High \| Urgent/);
});

test('the sample object carries no activity field, only the enums', () => {
  const p = buildActivityProgramPrompt(ctx);
  const sample = p.split('\n').find((l) => l.includes('"t":')) || '';
  assert.match(sample, /"f": "Health Camp"/);
  assert.match(sample, /"p": "Medium"/);
  assert.doesNotMatch(sample, /"a"/);
  assert.doesNotMatch(sample, /aid/);
});

test('prompt carries month observances as themes', () => {
  const p = buildActivityProgramPrompt({
    ...ctx,
    observances: [{ name: 'Diwali', scope: 'india', kind: 'festival' }],
  });
  assert.match(p, /Diwali \(india\/festival\)/);
  assert.match(p, /ONLY as themes/);
});

test('prompt tells the model not to invent an occasion when the month has none', () => {
  const p = buildActivityProgramPrompt({ ...ctx, observances: [] });
  assert.match(p, /no registered occasion/i);
  assert.doesNotMatch(p, /ONLY as themes/);
});

test('prompt lists existing programmes so the model can avoid them', () => {
  const p = buildActivityProgramPrompt({ ...ctx, existingTitles: ['Basic Computer Course'] });
  assert.match(p, /Basic Computer Course/);
});

test('prompt grounds the suggestions in the NGO code and the beneficiary group', () => {
  const p = buildActivityProgramPrompt({
    ...ctx,
    ngoCode: 'BSCT',
    beneficiaryGroup: 'Visually Impaired',
  });
  assert.match(p, /Its code is BSCT\./);
  assert.match(p, /This activity serves: "Visually Impaired"\./);
  assert.match(p, /must suit this group/);
});

test('the NGO code and beneficiary lines are omitted when not supplied', () => {
  // A blank value must not reach the model as an empty instruction line.
  const p = buildActivityProgramPrompt({ ...ctx, ngoCode: '', beneficiaryGroup: '' });
  assert.doesNotMatch(p, /Its code is/);
  assert.doesNotMatch(p, /This activity serves/);
});

test('the beneficiary line is capped so a long group cannot flood the prompt', () => {
  const p = buildActivityProgramPrompt({ ...ctx, beneficiaryGroup: 'V'.repeat(400) });
  const line = p.split('\n').find((l) => l.includes('This activity serves')) || '';
  const quoted = (line.match(/"([^"]*)"/) || [])[1] || '';
  assert.ok(quoted.length > 0, 'the group must still reach the model');
  assert.ok(quoted.length <= 120, `quoted group was ${quoted.length} chars`);
});

test('the beneficiary context costs input tokens only — the output budget is untouched', () => {
  const bare = buildActivityProgramPrompt(ctx);
  const rich = buildActivityProgramPrompt({ ...ctx, ngoCode: 'BSCT', beneficiaryGroup: 'Women' });
  assert.equal(bare.match(/EXACTLY 6 objects/) !== null, rich.match(/EXACTLY 6 objects/) !== null);
  assert.equal(bare.match(/about 950 output tokens/) !== null, rich.match(/about 950 output tokens/) !== null);
});

/* ── Enum coercion ───────────────────────────────────────────────────────── */

test('matchEnum prefers exact, then contains, then the fallback', () => {
  const allowed = ['Low', 'Medium', 'High', 'Urgent'];
  assert.equal(matchEnum('High', allowed, 'Medium'), 'High');
  assert.equal(matchEnum('high', allowed, 'Medium'), 'High');
  assert.equal(matchEnum('SUPER-URGENT', allowed, 'Medium'), 'Urgent');
  assert.equal(matchEnum('nonsense', allowed, 'Medium'), 'Medium');
  assert.equal(matchEnum(undefined, allowed, 'Medium'), 'Medium');
  assert.equal(matchEnum('workshop', ['Health Camp', 'Workshop'], ''), 'Workshop');
});

/* ── Normalisation ───────────────────────────────────────────────────────── */

test('a suggestion is stamped with the resolved activity, never the model\'s own', () => {
  const s = normalizeActivitySuggestion(
    { t: 'Basic Computer Course', a: 'Something The Model Invented', aid: 999 },
    { activityName: 'Computer Literacy Training', activityId: 12 },
  );
  assert.equal(s.activityName, 'Computer Literacy Training');
  assert.equal(s.activityId, 12);
});

test('date-ish keys are stripped and date is always null', () => {
  const raw = { t: 'Course', date: '2026-10-05', day: 'Monday', month: 'October', year: 2026, when: 'soon' };
  const s = normalizeActivitySuggestion(raw, { activityName: 'A', activityId: 1 });
  assert.equal(s.date, null);
  for (const k of ['day', 'month', 'year', 'when']) assert.equal(k in s, false);
  assert.equal('date' in s, true);
  assert.equal(s.date, null);
});

test('a suggestion with no title is dropped rather than rendered blank', () => {
  assert.equal(normalizeActivitySuggestion({ t: '   ' }, {}), null);
  assert.equal(normalizeActivitySuggestion({ u: 'audience only' }, {}), null);
  assert.equal(normalizeActivitySuggestion(null, {}), null);
  assert.equal(normalizeActivitySuggestion('a string', {}), null);
});

test('long keys win over the compact aliases', () => {
  const s = normalizeActivitySuggestion(
    { t: 'Alias', title: 'Long Key Title', u: 'short', audience: 'Long Key Audience' },
    {},
  );
  assert.equal(s.title, 'Long Key Title');
  assert.equal(s.audience, 'Long Key Audience');
});

test('materials are capped and cleaned', () => {
  const s = normalizeActivitySuggestion(
    { t: 'Camp', m: ['  ', 'Laptops', 'Projector', 'Charts', 'E', 'F', 'G'] },
    {},
  );
  assert.deepEqual(s.materials, ['Laptops', 'Projector', 'Charts', 'E', 'F', 'G']);
});

/* ── Parsing ─────────────────────────────────────────────────────────────── */

const raw = (title, over = {}) => ({
  t: title,
  f: 'Workshop',
  p: 'High',
  u: 'Rural youth',
  d: 'Half day',
  o: 'objective',
  r: 'rationale',
  m: ['Laptops', 'Trainer'],
  ...over,
});

test('parses the { suggestions: [...] } envelope the prompt asks for', () => {
  const out = parseActivityProgramSuggestions(
    { suggestions: [raw('One'), raw('Two')] },
    { activityName: 'A', activityId: 1 },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'One');
  assert.equal(out[1].priority, 'High');
});

test('parses a bare array too, since providers vary', () => {
  assert.equal(parseActivityProgramSuggestions([raw('One')]).length, 1);
});

test('a truncated response yields only the complete objects, and is still usable', () => {
  // Mirrors a finish_reason=length cut: a whole object followed by a fragment.
  const out = parseActivityProgramSuggestions(
    { suggestions: [raw('One'), { t: 'Two', o: 'trunc' }] },
    { activityName: 'A', activityId: 1 },
  );
  assert.deepEqual(out.map((s) => s.title), ['One', 'Two']);
});

test('caps at the limit even when the model over-delivers', () => {
  const many = { suggestions: Array.from({ length: 12 }, (_, i) => raw(`P${i}`)) };
  const out = parseActivityProgramSuggestions(many, { limit: ACTIVITY_SUGGESTION_LIMIT });
  assert.equal(out.length, ACTIVITY_SUGGESTION_LIMIT);
  assert.equal(out.at(-1).title, `P${ACTIVITY_SUGGESTION_LIMIT - 1}`);
});

test('de-duplicates repeated titles case-insensitively', () => {
  const out = parseActivityProgramSuggestions({
    suggestions: [raw('Course'), raw('course'), raw('COURSE'), raw('Other')],
  });
  assert.deepEqual(out.map((s) => s.title), ['Course', 'Other']);
});

test('de-duplicates against programmes already planned', () => {
  const out = parseActivityProgramSuggestions(
    { suggestions: [raw('Existing'), raw('Fresh')] },
    { existingTitles: ['existing'] },
  );
  assert.deepEqual(out.map((s) => s.title), ['Fresh']);
});

test('unusable model output degrades to empty instead of throwing', () => {
  assert.deepEqual(parseActivityProgramSuggestions(null), []);
  assert.deepEqual(parseActivityProgramSuggestions({}), []);
  assert.deepEqual(parseActivityProgramSuggestions('nope'), []);
  assert.deepEqual(parseActivityProgramSuggestions({ suggestions: 'not an array' }), []);
  assert.deepEqual(parseActivityProgramSuggestions({ suggestions: [null, 5, 'x'] }), []);
});
test('a saved beneficiary group is accepted whatever its spacing or casing', () => {
  for (const g of ACTIVITY_BENEFICIARY_GROUPS) {
    assert.equal(canonicalActivityBeneficiary(g), g);
    assert.equal(canonicalActivityBeneficiary(`  ${g.toLowerCase()}  `), g);
    assert.equal(canonicalActivityBeneficiary(g.toUpperCase()), g);
  }
});

test('a value outside the three groups is refused, so it cannot reach the prompt', () => {
  assert.equal(canonicalActivityBeneficiary('Everyone'), '');
  assert.equal(canonicalActivityBeneficiary('Visually Impaired, Women'), '');
  assert.equal(canonicalActivityBeneficiary('Visually Impairedx'), '');
});

test('an absent group is empty, which is what makes the NGO default apply', () => {
  assert.equal(canonicalActivityBeneficiary(''), '');
  assert.equal(canonicalActivityBeneficiary(null), '');
  assert.equal(canonicalActivityBeneficiary(undefined), '');
  assert.equal(canonicalActivityBeneficiary('   '), '');
});
