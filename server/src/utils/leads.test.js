import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERTED_STATUSES,
  REJECTED_STATUSES,
  isConvertedStatus,
  isRejectedStatus,
  leadBelongsTo,
  countConverted,
  countRejected,
  conversionRate,
} from './leads.js';

const recruiter = (over = {}) => ({ id: 'r-1', name: 'Bhumika Rai', ...over });
const lead = (over = {}) => ({ id: 'L1', status: 'new', ...over });

// The recruiter UI writes `selected` where the pipeline writes `joined`, which is
// why a counter that only reads one of them reports a 0% success rate.
test('every status the app calls a win counts as converted', () => {
  for (const status of CONVERTED_STATUSES) {
    assert.equal(isConvertedStatus(status), true, status);
  }
});

test('converted status matching ignores case and stray whitespace', () => {
  assert.equal(isConvertedStatus('Selected'), true);
  assert.equal(isConvertedStatus('  JOINED '), true);
});

test('an in-progress or lost status is never converted', () => {
  for (const status of ['new', 'scheduled', 'hold', 'rejected', 'not_interested', '']) {
    assert.equal(isConvertedStatus(status), false, status);
  }
  assert.equal(isConvertedStatus(null), false);
  assert.equal(isConvertedStatus(undefined), false);
});

test('the two ways of rejecting a candidate are both losses', () => {
  assert.equal(isRejectedStatus('rejected'), true);
  assert.equal(isRejectedStatus('not_interested'), true);
  assert.equal(isRejectedStatus('not interested'), false);
  assert.equal(isRejectedStatus('selected'), false);
  for (const status of REJECTED_STATUSES) {
    assert.equal(isRejectedStatus(status), true, status);
  }
});

test('a lead assigned to the recruiter belongs to them', () => {
  assert.equal(leadBelongsTo(lead({ recruiter_id: 'r-1' }), recruiter()), true);
});

test('a lead the recruiter entered belongs to them even unassigned', () => {
  assert.equal(leadBelongsTo(lead({ created_by: 'r-1' }), recruiter()), true);
});

test('a name-only lead still lands on its recruiter', () => {
  // These rows never stored an id, which is what silently emptied the
  // leaderboards: id equality alone can never match them.
  assert.equal(leadBelongsTo(lead({ created_by_name: 'Bhumika Rai' }), recruiter()), true);
  assert.equal(leadBelongsTo(lead({ scheduled_by_name: 'Bhumika Rai' }), recruiter()), true);
});

test('name-only matching ignores case, padding, and a missing stamp', () => {
  assert.equal(leadBelongsTo(lead({ created_by_name: '  bhumika rai ' }), recruiter()), true);
  assert.equal(leadBelongsTo(lead({ created_by_name: null }), recruiter()), false);
});

test('a lead belonging to someone else is not claimed by name alone', () => {
  assert.equal(
    leadBelongsTo(lead({ recruiter_id: 'r-2', created_by_name: 'Bhumika Rai' }), recruiter()),
    true,
    'the recruiter who entered it still owns it'
  );
  assert.equal(leadBelongsTo(lead({ created_by_name: 'Pooja Patel' }), recruiter()), false);
});

test('a recruiter with no name never matches on the name stamps', () => {
  assert.equal(leadBelongsTo(lead({ created_by_name: 'Bhumika Rai' }), recruiter({ name: '' })), false);
  assert.equal(leadBelongsTo(lead({ recruiter_id: 'r-1' }), recruiter({ name: null })), true);
});

test('ids compare as strings so a numeric id still matches', () => {
  assert.equal(leadBelongsTo(lead({ recruiter_id: 7 }), recruiter({ id: '7' })), true);
});

test('missing lead or missing recruiter is not an ownership claim', () => {
  assert.equal(leadBelongsTo(null, recruiter()), false);
  assert.equal(leadBelongsTo(lead(), null), false);
  assert.equal(leadBelongsTo(lead(), undefined), false);
});

test('counting converts and rejections over a mixed pipeline', () => {
  const leads = [
    lead({ id: 'a', status: 'selected' }),
    lead({ id: 'b', status: 'joined' }),
    lead({ id: 'c', status: 'rejected' }),
    lead({ id: 'd', status: 'not_interested' }),
    lead({ id: 'e', status: 'scheduled' }),
  ];
  assert.equal(countConverted(leads), 2);
  assert.equal(countRejected(leads), 2);
});

// Undecided leads stay out of the denominator so a fresh pipeline does not read
// as a failure.
test('conversion rate ignores leads nobody has decided on', () => {
  const leads = [
    lead({ id: 'a', status: 'selected' }),
    lead({ id: 'b', status: 'rejected' }),
    lead({ id: 'c', status: 'scheduled' }),
    lead({ id: 'd', status: 'hold' }),
  ];
  assert.equal(conversionRate(leads), 50);
});

test('conversion rate is 0 rather than a division by zero when nothing is decided', () => {
  assert.equal(conversionRate([lead({ status: 'scheduled' })]), 0);
  assert.equal(conversionRate([]), 0);
  assert.equal(conversionRate(null), 0);
});

test('conversion rate rounds to one decimal place', () => {
  const leads = [
    lead({ id: 'a', status: 'joined' }),
    lead({ id: 'b', status: 'joined' }),
    lead({ id: 'c', status: 'rejected' }),
  ];
  assert.equal(conversionRate(leads), 66.7);
});

test('a fully converted pipeline reads as 100', () => {
  assert.equal(conversionRate([lead({ status: 'offer_accepted' })]), 100);
});