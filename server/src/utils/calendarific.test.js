import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapCalendarificRows,
  classifyCalendarific,
  normalizeObservanceName,
  mergeCalendarific,
} from './calendarific.js';

// ── classify + map (shapes verified against the live Calendarific API) ──────

test('classifies a national day as india/national', () => {
  assert.deepEqual(
    classifyCalendarific({ type: ['National holiday'], primary_type: 'Gazetted Holiday' }),
    { scope: 'india', kind: 'national' },
  );
});

test('classifies a religion-tagged day as india/religious (type list)', () => {
  assert.deepEqual(
    classifyCalendarific({ type: ['Hinduism', 'Optional holiday'], primary_type: 'Restricted Holiday' }),
    { scope: 'india', kind: 'religious' },
  );
});

test('classifies an observance as worldwide/observance (Calendars official bucket)', () => {
  assert.deepEqual(
    classifyCalendarific({ type: ['Observance'], primary_type: 'Observance' }),
    { scope: 'worldwide', kind: 'observance' },
  );
});

test('religion primary_type also maps to india/religious', () => {
  assert.deepEqual(
    classifyCalendarific({ type: [], primary_type: 'Christian' }),
    { scope: 'india', kind: 'religious' },
  );
});

test('season rows are dropped (equinoxes/solstices are not observances)', () => {
  assert.equal(
    classifyCalendarific({ type: ['Season'], primary_type: 'Season' }),
    null,
  );
  assert.equal(
    classifyCalendarific({ type: [], primary_type: 'Season' }),
    null,
  );
});

test('government holiday maps to india/national', () => {
  assert.deepEqual(
    classifyCalendarific({ type: [], primary_type: 'Government Holiday' }),
    { scope: 'india', kind: 'national' },
  );
});

test('mapCalendarificRows builds observance entries and skips bad rows', () => {
  const rows = mapCalendarificRows([
    { name: 'Diwali/Deepavali', date: { iso: '2026-11-08', datetime: {} }, type: ['National holiday'], primary_type: 'Gazetted Holiday', description: 'Festival of lights.' },
    { name: 'World Diabetes Day', date: { iso: '2026-11-14' }, type: ['Observance'], primary_type: 'Observance' },
    { name: 'Equinox', date: { iso: '2026-03-20' }, type: ['Season'], primary_type: 'Season' },
    { name: '', date: { iso: '2026-05-01' }, type: ['Observance'], primary_type: 'Observance' },
    { name: 'No date', date: {}, type: ['Observance'], primary_type: 'Observance' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Diwali/Deepavali');
  assert.equal(rows[0].scope, 'india');
  assert.equal(rows[0].kind, 'national');
  assert.equal(rows[0].source, 'calendarific');
  assert.equal(rows[0].precision, 'fixed');
  assert.equal(rows[0].note, 'Festival of lights.');
  assert.equal(rows[1].scope, 'worldwide');
  assert.equal(rows[1].kind, 'observance');
});

// ── normalizeObservanceName ────────────────────────────────────────────────

test('normalizeObservanceName folds case and collapses punctuation/space', () => {
  assert.equal(normalizeObservanceName("Children's Day"), 'children s day');
  assert.equal(normalizeObservanceName("Children's Day (India)"), 'children s day india');
  assert.equal(normalizeObservanceName(' Diwali/Deepavali '), 'diwali deepavali');
  assert.equal(normalizeObservanceName('   '), '');
  assert.equal(normalizeObservanceName(null), '');
});

// ── mergeCalendarific ───────────────────────────────────────────────────────

const curated = [
  { date: '2026-11-14', name: "Children's Day (India)", scope: 'india', kind: 'observance', source: 'curated' },
  { date: '2026-11-14', name: 'World Diabetes Day', scope: 'worldwide', kind: 'observance', source: 'curated' },
];

test('exact duplicates are dropped (curated wins), variants coexist', () => {
  const extra = [
    { date: '2026-11-14', name: "Children's Day (India)", scope: 'india', kind: 'observance', source: 'calendarific' },
    { date: '2026-11-14', name: 'Some Other Day', scope: 'worldwide', kind: 'observance', source: 'calendarific' },
  ];
  const merged = mergeCalendarific(curated, extra);
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((o) => o.name === "Children's Day (India)").length, 1);
  assert.deepEqual(merged.map((o) => o.name).filter((n) => n === 'Some Other Day'), ['Some Other Day']);
});

test('calendarific rows that normalize to a curated name are deduped', () => {
  const extra = [
    { date: '2026-11-14', name: 'Diwali/Deepavali', scope: 'india', kind: 'religious', source: 'calendarific' },
  ];
  const base = [
    { date: '2026-11-08', name: 'Diwali (Deepavali)', scope: 'india', kind: 'religious', source: 'curated' },
  ];
  // Different date -> kept.
  assert.equal(mergeCalendarific(base, extra).length, 2);
  // Same date, normalized name matches -> dropped (curated wins).
  const sameDate = [{ date: '2026-11-08', name: 'Diwali/Deepavali', scope: 'india', kind: 'religious', source: 'calendarific' }];
  assert.equal(mergeCalendarific(base, sameDate).length, 1);
});

test('multiple rows per date are preserved and scope filter restricts append', () => {
  const extra = [
    { date: '2026-11-14', name: 'Row A', scope: 'india', kind: 'observance', source: 'calendarific' },
    { date: '2026-11-14', name: 'Row B', scope: 'worldwide', kind: 'observance', source: 'calendarific' },
    { date: '2026-11-08', name: 'Row C', scope: 'india', kind: 'national', source: 'calendarific' },
  ];
  assert.equal(mergeCalendarific([], extra, 'all').length, 3);
  const indiaOnly = mergeCalendarific([], extra, 'india');
  assert.deepEqual(indiaOnly.map((o) => o.name).sort(), ['Row A', 'Row C']);
});

test('mergeCalendarific does not mutate the input list', () => {
  const before = curated.map((o) => ({ ...o }));
  mergeCalendarific(curated, [{ date: '2026-11-14', name: 'Extra', scope: 'india', kind: 'observance', source: 'calendarific' }]);
  assert.deepEqual(curated, before);
});

test('output is sorted by date then name', () => {
  const extra = [
    { date: '2026-11-08', name: 'Zeta', scope: 'india', kind: 'observance', source: 'calendarific' },
    { date: '2026-10-02', name: 'Alpha', scope: 'india', kind: 'observance', source: 'calendarific' },
  ];
  const merged = mergeCalendarific([], extra, 'all');
  assert.deepEqual(merged.map((o) => o.name), ['Alpha', 'Zeta']);
});