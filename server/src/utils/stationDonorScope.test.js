import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStationNgoScope,
  dedupeStationDonors,
  ngoIdsMissingNames,
} from './stationDonorScope.js';

test('an omitted ngo_id keeps the cross-NGO union', () => {
  const res = resolveStationNgoScope([1, 2, 3], undefined);
  assert.deepEqual(res, { ok: true, ids: [1, 2, 3] });
});

test('an empty string ngo_id is treated as omitted, not as a scope', () => {
  const res = resolveStationNgoScope([1, 2], '');
  assert.deepEqual(res, { ok: true, ids: [1, 2] });
});

test('a requested ngo_id narrows the query to that one NGO', () => {
  const res = resolveStationNgoScope([1, 2, 3], '2');
  assert.deepEqual(res, { ok: true, ids: [2] });
});

test('numeric access ids match a string query param', () => {
  const res = resolveStationNgoScope([7], '7');
  assert.deepEqual(res, { ok: true, ids: [7] });
});

test('an inaccessible ngo_id is refused instead of silently unioning', () => {
  const res = resolveStationNgoScope([1, 2], '9');
  assert.equal(res.ok, false);
  assert.match(res.message, /No NGO access/);
});

test('blank access ids are dropped rather than queried', () => {
  const res = resolveStationNgoScope([1, null, undefined, '', 2], undefined);
  assert.deepEqual(res, { ok: true, ids: [1, 2] });
});

test('ids keep their original type, since they go straight into a query', () => {
  const res = resolveStationNgoScope(['1', '2'], undefined);
  assert.deepEqual(res.ids, ['1', '2']);
  assert.equal(typeof res.ids[0], 'string');
});

// The bug: donor 7 is assigned in two NGOs under the same station name. Keyed on
// donor_id alone the second row was dropped and the survivor carried whichever
// NGO happened to be iterated first - which is how a station list ended up
// showing an FRO that does not belong to that station.
test('the same donor in two NGOs is two rows, each keeping its own NGO', () => {
  const rows = [
    { ngo_id: 1, donor_id: 7, fro_name: 'FRO-A' },
    { ngo_id: 2, donor_id: 7, fro_name: 'FRO-B' },
  ];
  assert.equal(dedupeStationDonors(rows).length, 2);
});

test('dedupe keys on ngo and donor together, so both FROs survive', () => {
  const out = dedupeStationDonors([
    { ngo_id: 1, donor_id: 7, fro_name: 'FRO-A' },
    { ngo_id: 2, donor_id: 7, fro_name: 'FRO-B' },
  ]);
  assert.deepEqual(out.map(r => r.fro_name), ['FRO-A', 'FRO-B']);
});

test('a genuine duplicate inside one NGO still collapses to one row', () => {
  const out = dedupeStationDonors([
    { ngo_id: 1, donor_id: 7, id: 10 },
    { ngo_id: 1, donor_id: 7, id: 11 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 10, 'first row wins, so ordering stays predictable');
});

test('distinct donors within one NGO are untouched', () => {
  const rows = [
    { ngo_id: 1, donor_id: 7 },
    { ngo_id: 1, donor_id: 8 },
  ];
  assert.equal(dedupeStationDonors(rows).length, 2);
});

test('dedupe tolerates null and empty input', () => {
  assert.deepEqual(dedupeStationDonors(null), []);
  assert.deepEqual(dedupeStationDonors([]), []);
});

test('an ngo id with no access name is reported as needing a lookup', () => {
  const missing = ngoIdsMissingNames(
    [{ ngo_id: 1, ngo_name: 'BSCT' }],
    [1, 2]
  );
  assert.deepEqual(missing, [2]);
});

test('ids that already have a name are not looked up again', () => {
  const missing = ngoIdsMissingNames(
    [{ ngo_id: '1', ngo_name: 'BSCT' }],
    ['1']
  );
  assert.deepEqual(missing, []);
});

test('an access row without a name counts as missing', () => {
  const missing = ngoIdsMissingNames(
    [{ ngo_id: 4, ngo_name: '' }],
    [4]
  );
  assert.deepEqual(missing, [4]);
});
