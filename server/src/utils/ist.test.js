// IST month boundaries, and the UTC-vs-IST disagreement they exist to end.
//
// The old month key everywhere in the FRO code was
// `new Date().toISOString().slice(0, 7)`, which is a UTC month. IST is UTC+5:30,
// so for the first 5h30m of every month the UTC date is still the last day of the
// previous month. The tests below pin the exact instants either side of that
// boundary and assert what the old expression returned, so the bug cannot be
// reintroduced by "simplifying" the helper back to a toISOString().slice().

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istMonthKey, istMonthStartUtc, istMonthBounds } from './ist.js';

const at = (iso) => new Date(iso);

// 2026-10-01 00:00:00 IST == 2026-09-30 18:30:00Z. This is the single instant
// where the two calendars disagree about the month.
const IST_MIDNIGHT_1ST = '2026-09-30T18:30:00Z';
const JUST_BEFORE = '2026-09-30T18:29:59Z';

test('month key follows IST, not UTC, across the 1st-of-month boundary', () => {
  assert.equal(istMonthKey(at(IST_MIDNIGHT_1ST)), '2026-10');
  assert.equal(istMonthKey(at(JUST_BEFORE)), '2026-09');
});

test('the whole 00:00-05:30 IST window reads as the new month, not the old one', () => {
  for (const iso of [
    '2026-09-30T18:30:00Z', // 00:00 IST
    '2026-09-30T20:00:00Z', // 01:30 IST
    '2026-09-30T23:59:59Z', // 05:29:59 IST - last second of the old window
  ]) {
    assert.equal(istMonthKey(at(iso)), '2026-10', `failed at ${iso}`);
  }
});

test('the old UTC-based expression disagrees inside that window', () => {
  // Asserted on purpose: it documents what was wrong rather than what is right.
  assert.equal(at(IST_MIDNIGHT_1ST).toISOString().slice(0, 7), '2026-09');
  assert.equal(at('2026-09-30T23:59:59Z').toISOString().slice(0, 7), '2026-09');
});

test('the month key is stable everywhere else in the month', () => {
  for (const iso of ['2026-10-01T00:00:00Z', '2026-10-15T06:30:00Z', '2026-10-31T18:29:59Z']) {
    assert.equal(istMonthKey(at(iso)), '2026-10', `failed at ${iso}`);
  }
});

test('month start is 00:00 IST on the 1st, which is 18:30 UTC on the 30th', () => {
  const start = istMonthStartUtc(at('2026-10-15T10:00:00Z'));
  assert.equal(start.toISOString(), '2026-09-30T18:30:00.000Z');
});

test('istMonthBounds returns one consistent set of values for October', () => {
  const b = istMonthBounds(at('2026-10-15T10:00:00Z'));

  assert.equal(b.monthKey, '2026-10');
  assert.equal(b.month, '2026-10-01', 'the value fro_monthly_targets.month is keyed by');
  assert.equal(b.startDay, '2026-10-01');
  assert.equal(b.endDay, '2026-10-31');
  assert.equal(b.start.toISOString(), '2026-09-30T18:30:00.000Z');
  // End is the last millisecond of 31 Oct IST, i.e. 1ms before 1 Nov IST.
  assert.equal(b.end.toISOString(), '2026-10-31T18:29:59.999Z');
});

test('the bounds still describe the new month when asked inside the UTC gap', () => {
  const b = istMonthBounds(at(IST_MIDNIGHT_1ST));
  assert.equal(b.month, '2026-10-01');
  assert.equal(b.startDay, '2026-10-01');
  assert.equal(b.endDay, '2026-10-31');
});

test('month end accounts for a short month', () => {
  assert.equal(istMonthBounds(at('2026-02-10T10:00:00Z')).endDay, '2026-02-28');
  assert.equal(istMonthBounds(at('2026-04-10T10:00:00Z')).endDay, '2026-04-30');
});

test('a leap February gets the 29th', () => {
  assert.equal(istMonthBounds(at('2028-02-10T10:00:00Z')).endDay, '2028-02-29');
});

test('the month rolls over on the 1st IST, not the 1st UTC', () => {
  // 2026-10-31T19:00:00Z is already 00:30 IST on 1 Nov.
  assert.equal(istMonthKey(at('2026-10-31T18:29:59Z')), '2026-10');
  assert.equal(istMonthKey(at('2026-10-31T18:30:00Z')), '2026-11');
});

test('year rolls over inside December on the IST boundary', () => {
  const b = istMonthBounds(at('2026-12-31T18:45:00Z')); // 00:15 IST, 1 Jan 2027
  assert.equal(b.monthKey, '2027-01');
  assert.equal(b.month, '2027-01-01');
  assert.equal(b.endDay, '2027-01-31');
});