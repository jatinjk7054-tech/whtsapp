/**
 * Tests for the audience-voting scoring rules.
 *
 * These functions carry the rules that are easy to break by accident and
 * expensive to get wrong once an event is live:
 *
 *   1. timingScore - the three-way timing choice resolving to a score on the same
 *                    1..5 scale as the star rows. Getting this wrong either
 *                    silently scores a misspelled key as the floor, or drops the
 *                    criterion out of the overall average.
 *   2. overallScore - the five-criterion mean that every ranking depends on.
 *   3. normName     - free text from an admin typing and an audience member on a
 *                    phone.
 *   4. round1       - display rounding only.
 *
 * The one-rating-per-speaker rule is NOT tested here: it is enforced by
 * UNIQUE (participant_id, voter_id) in the schema, so it cannot regress without
 * a migration, which is the point of putting it there rather than in a
 * read-then-write in the controller.
 *
 * The DB-backed parts of the module are not covered; importing this file only
 * pulls in the pg Pool, which does not open a connection until a query runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  timingScore,
  TIMING_SCORES,
  TIMING_CHOICES,
  overallScore,
  normName,
  round1,
  STAR_KEYS,
  STAR_CRITERIA,
} from '../models/audienceVotingModel.js';

const full = (over = {}) => ({ delivery: 5, confidence: 4, clarity: 3, relevance: 4, timing: 5, ...over });

// ── timingScore ────────────────────────────────────────────────────────────

test('timingScore maps each choice to its agreed score', () => {
  assert.equal(timingScore('before'), 1);
  assert.equal(timingScore('beyond'), 3);
  assert.equal(timingScore('on_time'), 5);
});

test('timingScore ignores case and surrounding whitespace', () => {
  assert.equal(timingScore('  ON_TIME '), 5);
  assert.equal(timingScore('Before'), 1);
});

test('timingScore returns null for an unknown choice rather than falling back', () => {
  // A fallback of 1 here would quietly drag a speaker's average down every time a
  // client sent a key the server does not know about, so this must be null and
  // the controller must reject it.
  assert.equal(timingScore('later'), null);
  assert.equal(timingScore(''), null);
  assert.equal(timingScore(null), null);
  assert.equal(timingScore(undefined), null);
});

test('every timing choice has a distinct score on the 1..5 scale', () => {
  const scores = TIMING_CHOICES.map((c) => c.score);
  assert.equal(new Set(scores).size, scores.length, 'two timing choices share a score');
  for (const s of scores) {
    assert.ok(Number.isInteger(s) && s >= 1 && s <= 5, `timing score ${s} is outside 1..5`);
  }
  assert.equal(Object.keys(TIMING_SCORES).length, TIMING_CHOICES.length);
});

// ── overallScore ───────────────────────────────────────────────────────────

test('overallScore is the mean of all five criteria', () => {
  assert.equal(overallScore(full()), (5 + 4 + 3 + 4 + 5) / 5);
  assert.equal(overallScore(full({ timing: 1 })), (5 + 4 + 3 + 4 + 1) / 5);
});

test('overallScore weights every criterion equally', () => {
  // The timing criterion counts once, the same as each star. A regression that
  // summed only the star rows would read 4 here instead of 3.8.
  assert.equal(overallScore(full({ delivery: 1, confidence: 1, clarity: 1, relevance: 1, timing: 5 })), 1.8);
});

test('overallScore returns null for an incomplete row rather than a partial mean', () => {
  // A three-criteria average reads like a real score and is not one, so this
  // must be null so callers can show "not enough ratings yet".
  assert.equal(overallScore({ delivery: 5, confidence: 4, clarity: 3, relevance: 4 }), null);
  assert.equal(overallScore({}), null);
  assert.equal(overallScore(null), null);
});

test('overallScore accepts numeric strings from a form post', () => {
  assert.equal(overallScore({ delivery: '5', confidence: '4', clarity: '3', relevance: '4', timing: '5' }), 4.2);
});

test('overallScore ignores no criterion silently', () => {
  // Guards the column list: every star key must actually participate.
  assert.equal(STAR_KEYS.length, STAR_CRITERIA.length);
  for (const key of STAR_KEYS) {
    const row = full();
    row[key] = 1;
    assert.notEqual(overallScore(row), 4.2, `${key} does not affect the overall score`);
  }
});

// ── normName ───────────────────────────────────────────────────────────────

test('normName trims and collapses inner whitespace', () => {
  assert.equal(normName('  Astha   Rao  '), 'Astha Rao');
  assert.equal(normName('Priya\tNair'), 'Priya Nair');
  assert.equal(normName('Asha'), 'Asha');
});

test('normName turns absent names into an empty string', () => {
  assert.equal(normName(null), '');
  assert.equal(normName(undefined), '');
  assert.equal(normName('   '), '');
});

// ── round1 ─────────────────────────────────────────────────────────────────

test('round1 rounds to one decimal for display only', () => {
  assert.equal(round1(3.849), 3.8);
  assert.equal(round1(3.85), 3.9);
  assert.equal(round1(4), 4);
  assert.equal(round1(0), 0);
});

test('round1 passes through null so an unrated speaker shows a dash, not a zero', () => {
  // AVG() over zero rows is NULL, and a 0 here would read as "rated zero".
  assert.equal(round1(null), null);
  assert.equal(round1(undefined), null);
  assert.equal(round1(NaN), null);
});