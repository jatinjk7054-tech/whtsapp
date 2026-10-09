import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRange, resolvePeriodRange, PERIODS, PERIOD_LABELS } from './teamCollectionService.js';

// The roster read and the SQL both live in teamCollectionService, so these cover the
// pure date/period logic that decides which window the board shows. The invariant
// that matters: every window is a pair of IST calendar days, `from <= to`, and no
// longer than the period claims - a leaderboard covering the wrong days is worse than
// no leaderboard.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const days = (from, to) => (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 + 1;

test('every advertised period resolves to a sane, ordered, labelled window', () => {
  assert.deepEqual(PERIODS, ['today', 'week', 'month']);
  for (const p of PERIODS) {
    const { from, to } = resolvePeriodRange(p);
    assert.match(from, DAY, `${p}: from must be a plain calendar day`);
    assert.match(to, DAY, `${p}: to must be a plain calendar day`);
    assert.ok(from <= to, `${p}: from must not be after to`);
    assert.ok(days(from, to) >= 1, `${p}: window must cover at least today`);
    assert.ok(PERIOD_LABELS[p], `${p}: needs a label for the filter UI`);
  }
});

test('today is a single day', () => {
  const { from, to } = resolvePeriodRange('today');
  assert.equal(from, to);
  assert.equal(days(from, to), 1);
});

test('week is a rolling 7 days ending today', () => {
  const { from, to } = resolvePeriodRange('week');
  assert.equal(days(from, to), 7, 'a "week" of 5 or 6 days would make the filter a lie');
  const today = resolvePeriodRange('today').to;
  assert.equal(to, today, 'the window must end on today, not in the future');
});

test('month starts on the 1st and ends today', () => {
  const { from, to } = resolvePeriodRange('month');
  assert.match(from, /-01$/, 'month-to-date has to start at the 1st, not 7 days back');
  assert.equal(to, resolvePeriodRange('today').to);
  const today = resolvePeriodRange('today').to;
  assert.equal(from.slice(0, 7), today.slice(0, 7), 'must not spill into the previous month');
});

test('an unknown or missing period falls back to today instead of failing', () => {
  const today = resolvePeriodRange('today');
  for (const p of ['', null, undefined, 'quarter', 'TODAY ', 'week; DROP TABLE receipts']) {
    assert.deepEqual(resolvePeriodRange(p), today, `${String(p)} must degrade to today`);
  }
});

test('resolveRange is strict by default and lenient when asked', () => {
  // The admin endpoint must 400 rather than silently invent a window.
  assert.equal(resolveRange({ from: '', to: '' }), null);
  assert.equal(resolveRange({ from: '2026-01-02', to: 'nope' }), null);
  // Shape-valid but not a real date: reaching Postgres would 500 instead of 400.
  assert.equal(resolveRange({ from: '2026-13-40', to: '2026-13-40' }), null);
  assert.equal(resolveRange({ from: '2026-02-30', to: '2026-02-30' }), null);
  assert.deepEqual(resolveRange({ from: '2024-02-29', to: '2024-02-29' }), { from: '2024-02-29', to: '2024-02-29' }, 'a real leap day must pass');

  const ok = resolveRange({ from: '2026-03-05', to: '2026-03-01' });
  assert.deepEqual(ok, { from: '2026-03-01', to: '2026-03-05' }, 'reversed input is swapped');

  const lenient = resolveRange({ from: '', to: '', strict: false });
  assert.equal(lenient.from, lenient.to, 'a filter-less caller defaults to today');
  assert.match(lenient.from, DAY);
});

test('a one-sided range fills the missing end from the one given', () => {
  const { from, to } = resolveRange({ from: '2026-03-05', to: '', strict: false });
  assert.equal(from, '2026-03-05');
  assert.equal(to, '2026-03-05', 'a single-day range must not silently become a month');
});
