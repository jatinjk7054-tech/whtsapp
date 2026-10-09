import test from 'node:test';
import assert from 'node:assert/strict';

import { getInternationalDaysInRange } from './importantDays.js';

test('returns the October anchor days with india/international typing', () => {
  const rows = getInternationalDaysInRange('2026-10-01', '2026-11-01');
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('World Food Day'), 'World Food Day (Oct 16) present');
  assert.ok(names.includes('World Mental Health Day'), 'World Mental Health Day (Oct 10) present');
  assert.ok(names.includes('United Nations Day'), 'United Nations Day (Oct 24) present');
  const wfd = rows.find((r) => r.name === 'World Food Day');
  assert.equal(wfd.date, '2026-10-16');
  assert.equal(wfd.type, 'international');
  assert.equal(wfd.scope, 'worldwide');
  assert.equal(wfd.kind, 'observance');
  assert.equal(wfd.source, 'international');
  assert.equal(wfd.precision, 'fixed');
});

test('end date is exclusive', () => {
  const rows = getInternationalDaysInRange('2026-10-16', '2026-10-17');
  assert.deepEqual(rows.map((r) => r.name), ['World Food Day']);
});

test('empty list for an invalid or backwards range', () => {
  assert.deepEqual(getInternationalDaysInRange('2026-10-01', '2026-10-01'), []);
  assert.deepEqual(getInternationalDaysInRange('bad', '2026-11-01'), []);
});

test('same month/day exists in every supported year', () => {
  for (const year of [2025, 2026, 2027]) {
    const rows = getInternationalDaysInRange(`${year}-10-01`, `${year}-11-01`);
    assert.equal(rows.find((r) => r.name === 'World Food Day')?.date, `${year}-10-16`);
  }
});