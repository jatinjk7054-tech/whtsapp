// Covers the three shapes documents_value has taken: a legacy single value, a
// JSON array, and nothing at all. A regression here silently empties a
// volunteer's record across the worker list, the profile card and the ODAR
// letter, and the only symptom is a blank Documents Needed row.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_OPTIONS,
  OTHER_DOC,
  normalizeDocumentsValue,
  parseDocumentsValue,
  serializeDocuments,
  resolveDocumentLabels,
} from './documentsValue.js';

test('every offered option is accepted', () => {
  for (const opt of DOC_OPTIONS) {
    assert.equal(normalizeDocumentsValue(opt), opt);
  }
});

test('the option list is exactly the six agreed with the client', () => {
  assert.deepEqual(DOC_OPTIONS, [
    '10th',
    '12th',
    'Degree',
    'Voter ID',
    'Marriage Certificate',
    'Other',
  ]);
});

test('a near-miss is rejected on case and punctuation', () => {
  assert.equal(normalizeDocumentsValue('voter id'), null);
  assert.equal(normalizeDocumentsValue('Voter-ID'), null);
  assert.equal(normalizeDocumentsValue('12TH'), null);
  assert.equal(normalizeDocumentsValue('Others'), null);
});

test('clearing the field normalises to null', () => {
  assert.equal(normalizeDocumentsValue(''), null);
  assert.equal(normalizeDocumentsValue('   '), null);
  assert.equal(normalizeDocumentsValue(null), null);
  assert.equal(normalizeDocumentsValue(undefined), null);
});

test('a legacy single value still reads as a one-item selection', () => {
  // The shape written by the pre-multi-select dropdown, and still written by
  // anything that has not been rebuilt. Must not read as empty.
  assert.deepEqual(parseDocumentsValue('12th'), { selected: ['12th'], otherText: '' });
  assert.deepEqual(parseDocumentsValue(['12th']), { selected: ['12th'], otherText: '' });
  assert.deepEqual(parseDocumentsValue('12th').selected, ['12th']);
});

test('a JSON array string parses into a selection', () => {
  assert.deepEqual(
    parseDocumentsValue('["10th","Degree"]').selected,
    ['10th', 'Degree'],
  );
  assert.deepEqual(
    parseDocumentsValue(JSON.stringify(DOC_OPTIONS)).selected,
    DOC_OPTIONS,
  );
});

test('empty and absent values parse to an empty selection', () => {
  for (const empty of ['', '   ', '[]', null, undefined]) {
    assert.deepEqual(parseDocumentsValue(empty).selected, [], `for ${JSON.stringify(empty)}`);
  }
});

test('truncated JSON is salvaged instead of reading as empty', () => {
  // The failure mode that matters: a mangled column reading as "nothing
  // selected" blanks the volunteer's record everywhere it is displayed.
  assert.deepEqual(parseDocumentsValue('["10th","Deg').selected, ['10th']);
  assert.deepEqual(parseDocumentsValue('["10th","Degree"').selected, ['10th', 'Degree']);
  assert.deepEqual(parseDocumentsValue('[10th,Degree]').selected, ['10th', 'Degree']);
  assert.deepEqual(parseDocumentsValue("['10th','Other']").selected, ['10th', 'Other']);
  assert.doesNotThrow(() => parseDocumentsValue('{oops'));
});

test('unrecognisable text reads as no selection without throwing', () => {
  assert.deepEqual(parseDocumentsValue('not json at all').selected, []);
  assert.deepEqual(parseDocumentsValue('[]').selected, []);
  assert.deepEqual(parseDocumentsValue('["Passport"]').selected, []);
});

test('unknown entries are dropped and duplicates collapse', () => {
  assert.deepEqual(
    parseDocumentsValue('["10th","Passport","10th","Degree"]').selected,
    ['10th', 'Degree'],
  );
});

test('the stored order always follows DOC_OPTIONS, not click order', () => {
  // Ticking "Voter ID" then "10th" must store and print 10th first.
  assert.deepEqual(
    parseDocumentsValue('["Voter ID","10th","Degree"]').selected,
    ['10th', 'Degree', 'Voter ID'],
  );
  assert.deepEqual(serializeDocuments(['Marriage Certificate', '12th']).documents_value, '["12th","Marriage Certificate"]');
});

test('the custom name is carried alongside the selection', () => {
  const parsed = parseDocumentsValue('["Other"]', '  Passport  ');
  assert.deepEqual(parsed.selected, ['Other']);
  assert.equal(parsed.otherText, 'Passport');
});

test('an over-long custom name is bounded', () => {
  assert.equal(parseDocumentsValue('["Other"]', 'x'.repeat(500)).otherText.length, 120);
});

test('serialize writes both columns together', () => {
  assert.deepEqual(
    serializeDocuments(['12th', 'Other'], 'Passport'),
    { documents_value: '["12th","Other"]', documents_other: 'Passport' },
  );
});

test('unchecking Other drops its custom name', () => {
  assert.deepEqual(
    serializeDocuments(['12th'], 'Passport'),
    { documents_value: '["12th"]', documents_other: '' },
  );
});

test('Other with no name still stores the tick', () => {
  // The checkbox has to survive a reload even before the name is typed.
  assert.deepEqual(serializeDocuments(['Other'], ''), {
    documents_value: '["Other"]',
    documents_other: '',
  });
});

test('a round trip through serialize and parse is lossless', () => {
  const written = serializeDocuments(['10th', 'Voter ID', 'Other'], 'Passport');
  const read = parseDocumentsValue(written.documents_value, written.documents_other);
  assert.deepEqual(read.selected, ['10th', 'Voter ID', 'Other']);
  assert.equal(read.otherText, 'Passport');
});

test('a bare "Other" is replaced by the custom name in output labels', () => {
  assert.deepEqual(resolveDocumentLabels(['Other'], 'Passport'), ['Passport']);
  assert.deepEqual(resolveDocumentLabels(['10th', 'Other'], 'Passport'), ['10th', 'Passport']);
  assert.deepEqual(resolveDocumentLabels(['12th', 'Marriage Certificate'], ''), ['12th', 'Marriage Certificate']);
});

test('a bare "Other" is dropped when no name was ever given', () => {
  // Printing a literal "Other" in an acknowledgement tells nobody anything.
  assert.deepEqual(resolveDocumentLabels(['Other'], ''), []);
  assert.deepEqual(resolveDocumentLabels(['Other'], '   '), []);
  assert.deepEqual(resolveDocumentLabels(['10th', 'Other'], ''), ['10th']);
});

test('no selection yields no labels', () => {
  assert.deepEqual(resolveDocumentLabels([], ''), []);
  assert.deepEqual(resolveDocumentLabels(null, null), []);
});
