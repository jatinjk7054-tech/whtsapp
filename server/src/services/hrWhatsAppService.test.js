// Phone normalisation for HR > Letters WhatsApp sends.
//
// A volunteer's number reaches this module in whatever shape HR typed it into
// the workers table, and Meta wants country code + digits and nothing else. A
// send to a slightly-wrong number is a real message to a real stranger, so the
// rule is deliberately conservative: normalise the shapes that are unambiguous
// Indian mobiles, and reject everything else rather than guessing. The previous
// behaviour on this page was to fall back to a hardcoded number, which meant an
// employee with no phone on record got a warning letter meant for them sent to
// whoever happened to own that number.
//
// normalizeHrPhone is the single pure rule; isWithinServiceWindow and the two
// send functions are the write paths around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHrPhone, phoneVariants } from './hrWhatsAppService.js';

test('bare 10-digit mobiles get the +91 country code', () => {
  assert.equal(normalizeHrPhone('9876543210'), '919876543210');
  // Second fixture is deliberately not a real number. An earlier revision used a
  // number that matched a contact HR had hardcoded, and a test fixture is the
  // last place a real contact number should be reintroduced.
  assert.equal(normalizeHrPhone('8000000000'), '918000000000');
});

test('formatting characters HR may have typed are stripped', () => {
  const expected = '919876543210';
  assert.equal(normalizeHrPhone('98765 43210'), expected);
  assert.equal(normalizeHrPhone('98765-43210'), expected);
  assert.equal(normalizeHrPhone('+91 98765 43210'), expected);
  assert.equal(normalizeHrPhone('(98765) 43210'), expected);
  assert.equal(normalizeHrPhone('+91-9876543210'), expected);
});

test('an already 91-prefixed number is left alone, not double-prefixed', () => {
  assert.equal(normalizeHrPhone('919876543210'), '919876543210');
  assert.equal(normalizeHrPhone('91 98765 43210'), '919876543210');
});

test('a leading trunk zero is dropped in favour of the country code', () => {
  assert.equal(normalizeHrPhone('09876543210'), '919876543210');
});

test('an international number with its own country code is passed through', () => {
  assert.equal(normalizeHrPhone('+14155552671'), '14155552671');
  assert.equal(normalizeHrPhone('971501234567'), '971501234567');
});

test('an absent or too-short number yields empty rather than a guess', () => {
  // This is the case that used to fall through to the hardcoded number.
  assert.equal(normalizeHrPhone(''), '');
  assert.equal(normalizeHrPhone(null), '');
  assert.equal(normalizeHrPhone(undefined), '');
  assert.equal(normalizeHrPhone('   '), '');
  assert.equal(normalizeHrPhone('98765'), '');
  assert.equal(normalizeHrPhone('NA'), '');
  assert.equal(normalizeHrPhone('suspense'), '');
  // Nine digits is one short of an Indian mobile and cannot be completed safely.
  assert.equal(normalizeHrPhone('987654321'), '');
});

test('an implausibly long value is rejected instead of being dialled', () => {
  assert.equal(normalizeHrPhone('91987654321098765'), '');
});

test('variants include the local form so contact lookups match either storage shape', () => {
  assert.deepEqual(phoneVariants('919876543210'), ['919876543210', '9876543210']);
  assert.deepEqual(phoneVariants('9876543210'), ['919876543210', '9876543210']);
  // A non-Indian country code has no local form to offer.
  assert.deepEqual(phoneVariants('14155552671'), ['14155552671']);
  assert.deepEqual(phoneVariants(''), []);
});
