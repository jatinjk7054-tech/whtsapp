import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFestivalProgramPrompt,
  parseFestivalProgramSuggestions,
  beneficiaryGroupForNgo,
  ACTIVITY_SUGGESTION_LIMIT,
} from './activityProgramPrompt.js';
import { importantDayType, findObservanceForDate } from './observanceMerge.js';

test('buildFestivalProgramPrompt anchors on the festival and the NGO group', () => {
  const prompt = buildFestivalProgramPrompt({
    festivalName: "Children's Day",
    dateLabel: '14 November 2026',
    ngoName: 'BSCT',
    ngoCode: 'BSCT',
    beneficiaryGroup: 'Visually Impaired',
    sectorName: 'Education',
    monthYmd: '2026-11',
    existingTitles: ['Annual Camp'],
  });

  assert.match(prompt, /Children's Day/);
  assert.match(prompt, /14 November 2026/);
  assert.match(prompt, /Visually Impaired/);
  assert.match(prompt, /Education/);
  assert.match(prompt, /EXACTLY 6 objects/);
  assert.match(prompt, /Do not repeat programmes this NGO already has planned: Annual Camp/);
  assert.match(prompt, /Do NOT output any date/);
});

test('buildFestivalProgramPrompt drops the beneficiary line when none configured', () => {
  const prompt = buildFestivalProgramPrompt({ festivalName: 'Diwali', monthYmd: '2026-11' });
  assert.doesNotMatch(prompt, /The beneficiary group is:/);
  assert.match(prompt, /No specific beneficiary group is configured/);
});

test('parseFestivalProgramSuggestions normalises, dedupes and caps at the limit', () => {
  const parsed = {
    suggestions: Array.from({ length: 10 }, (_, i) => ({
      t: `Idea ${i + 1}`,
      f: 'Workshop',
      p: 'High',
      u: 'group',
      d: 'Half day',
      o: 'objective',
      r: 'rationale',
      m: ['A', 'B'],
      date: '12-12-2099', // date-ish key must be dropped
    })),
  };

  const out = parseFestivalProgramSuggestions(parsed, {});
  assert.equal(out.length, ACTIVITY_SUGGESTION_LIMIT);
  for (const s of out) {
    assert.equal(typeof s.title, 'string');
    assert.equal(s.date, null);
    assert.equal(s.activityId, null);
    assert.ok(Array.isArray(s.materials));
  }
});

test('parseFestivalProgramSuggestions skips titles already present', () => {
  const parsed = { suggestions: [
    { t: 'Duplicate Idea', f: 'Workshop' },
    { t: 'Fresh Idea', f: 'Camp' },
  ] };
  const out = parseFestivalProgramSuggestions(parsed, { existingTitles: ['duplicate idea'] });
  assert.deepEqual(out.map((s) => s.title), ['Fresh Idea']);
});

test('beneficiaryGroupForNgo maps the three codes and rejects everything else', () => {
  assert.equal(beneficiaryGroupForNgo('bsct'), 'Visually Impaired');
  assert.equal(beneficiaryGroupForNgo('MANN'), 'Women');
  assert.equal(beneficiaryGroupForNgo('aflf'), 'Underprivileged Families');
  assert.equal(beneficiaryGroupForNgo('unknown'), '');
});

test('importantDayType buckets india vs international correctly', () => {
  assert.equal(importantDayType({ scope: 'india' }), 'india');
  assert.equal(importantDayType({ scope: 'worldwide' }), 'international');
});

test('findObservanceForDate matches case-insensitively and returns null otherwise', () => {
  const rows = [
    { date: '2026-11-14', name: "Children's Day", source: 'international' },
    { date: '2026-11-14', name: 'World Diabetes Day' },
  ];
  const hit = findObservanceForDate(rows, '2026-11-14', "children's day");
  assert.ok(hit);
  assert.equal(hit.name, "Children's Day");
  assert.equal(findObservanceForDate(rows, '2026-11-14', 'Diwali'), null);
  assert.equal(findObservanceForDate(rows, '2026-11-15', "Children's Day"), null);
  assert.equal(findObservanceForDate([], '2026-11-14', ''), null);
});