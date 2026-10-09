// Per-recruiter lead scoping.
//
// A recruiter used to receive every lead in the table: listLeads only applied an
// owner filter to telecallers, and for a recruiter it honoured a caller-supplied
// ?created_by= instead of forcing their own id. getLead, removeLead and the
// dashboard aggregates applied no owner filter at all. These tests pin the rule
// the model now enforces so the leak cannot come back through a "simplification".
//
// Ownership means recruiter_id = me OR created_by = me, because HR assigns work
// by setting recruiter_id while an entry typed in the panel records created_by,
// and leads created in the panel have recruiter_id = NULL.
//
// Ids are UUIDs. Recruiters are rows in public.workers and authenticate with
// workers.id in their JWT, and leads.recruiter_id / leads.created_by are uuid
// columns. An earlier version of this normalised ids with Number(), which turned
// every recruiter id into NaN, dropped it, and left getAllLeads() taking its
// "the caller scoped to nobody, so show nobody" early return -- so both Pooja
// Patel and Bhumika Rai saw an empty panel while HR counted the same 376 rows.
// The UUID cases below are the regression guard for exactly that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ownsLead } from './leadModel.js';

// Real shapes from the live schema rather than small integers, so a future
// "optimisation" back to Number() fails here instead of in the panel.
const ME = '4bb39f39-08de-4beb-9653-5a3625cd1be1'; // Pooja Patel
const COLLEAGUE = '09a202b7-032d-45c3-98ae-77d180b339ed'; // Bhumika Rai

const lead = (over = {}) => ({
  id: '2a4493da-1b6f-4423-8339-8705294a970e',
  name: 'Candidate',
  recruiter_id: null,
  created_by: null,
  created_by_name: null,
  scheduled_by_name: null,
  ...over,
});

test('a lead entered by the recruiter is theirs', () => {
  assert.equal(ownsLead(lead({ created_by: ME }), [ME]), true);
});

test('a lead HR assigned to the recruiter is theirs', () => {
  assert.equal(ownsLead(lead({ recruiter_id: ME, created_by: COLLEAGUE }), [ME]), true);
});

test('a lead belonging to a colleague is not', () => {
  assert.equal(ownsLead(lead({ recruiter_id: COLLEAGUE, created_by: COLLEAGUE }), [ME]), false);
});

test('a lead with neither column set is not owned by id', () => {
  assert.equal(ownsLead(lead(), [ME]), false);
});

// The regression guard. A UUID owner id must resolve to a real id set, not to an
// empty one -- an empty set made every recruiter's list come back empty.
test('a UUID owner id is recognised, not silently dropped as unparseable', () => {
  assert.equal(ownsLead(lead({ created_by: ME }), [ME], 'Pooja Patel'), true);
  assert.equal(ownsLead(lead({ recruiter_id: ME }), [ME]), true);
});

test('ids compare across string and number, since a caller may supply either', () => {
  assert.equal(ownsLead(lead({ created_by: 7 }), ['7']), true);
  assert.equal(ownsLead(lead({ recruiter_id: '7' }), [7]), true);
});

test('surrounding whitespace on an id does not break the match', () => {
  assert.equal(ownsLead(lead({ created_by: ` ${ME} ` }), [`${ME}`]), true);
});

// Guards the edge case that would silently widen access: a NULL column must not be
// coerced to something an empty owner id could equal.
test('a NULL id never matches, including an empty-string owner id', () => {
  assert.equal(ownsLead(lead({ recruiter_id: null, created_by: null }), ['']), false);
  assert.equal(ownsLead(lead({ recruiter_id: null, created_by: null }), [0]), false);
  assert.equal(ownsLead(lead({ recruiter_id: null, created_by: null }), ['0']), false);
});

// Rows that predate the id columns keep only a display name. Those leads exist and
// belong to somebody, so the name clause is what stops them vanishing.
test('a name stamp matches when no id is present on the row', () => {
  assert.equal(ownsLead(lead({ created_by_name: 'Bhumika Rai' }), [COLLEAGUE], 'Bhumika Rai'), true);
  assert.equal(ownsLead(lead({ scheduled_by_name: 'Bhumika Rai' }), [COLLEAGUE], 'Bhumika Rai'), true);
});

test('name matching is case and whitespace insensitive', () => {
  assert.equal(ownsLead(lead({ created_by_name: '  bhumika rai ' }), [COLLEAGUE], 'Bhumika Rai'), true);
});

test('a name stamp belonging to a colleague is not', () => {
  assert.equal(ownsLead(lead({ created_by_name: 'Bhumika Rai' }), [ME], 'Pooja Patel'), false);
});

test('ownership needs an owner, so an empty scope owns nothing', () => {
  assert.equal(ownsLead(lead({ created_by: ME }), []), false);
  assert.equal(ownsLead(lead({ created_by: ME }), [null, undefined, '']), false);
  assert.equal(ownsLead(null, [ME]), false);
});
