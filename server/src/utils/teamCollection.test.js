// The roster-vs-data contract for team-wise collection.
//
// The failure this file exists to prevent: building the leaderboard from the
// receipts alone. A configured team that collected nothing in the selected range
// then produces no aggregate row, disappears off the board, and reappears later
// - so a motivational card silently drops teams on a bad day, which is exactly
// when the board is being watched. Every test below is about keeping the set of
// lanes stable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_TEAM_KEY,
  NO_TEAM_LABEL,
  DEFAULT_TEAMS,
  normalizeRoster,
  parseRosterSetting,
  teamLabel,
  teamSortRank,
  compareTeamLabels,
  shapeTeamCollection,
} from './teamCollection.js';

const ROSTER = ['UFS1', 'UFS2', 'UFS3', 'UFS4', 'UFS5'];

test('the roster is not a constant - it comes from the collection_teams setting', () => {
  // Five teams is the real state of the settings row; UFS1-UFS4 is only ever a
  // fallback, so nothing here may be hardcoded to a fixed count.
  assert.equal(parseRosterSetting(JSON.stringify(ROSTER)).length, 5);
  assert.equal(DEFAULT_TEAMS.length, 4);
  assert.notDeepEqual(parseRosterSetting(JSON.stringify(ROSTER)), DEFAULT_TEAMS);
});

test('parseRosterSetting falls back to the defaults for absent or corrupt rows', () => {
  assert.deepEqual(parseRosterSetting(null), DEFAULT_TEAMS);
  assert.deepEqual(parseRosterSetting(undefined), DEFAULT_TEAMS);
  assert.deepEqual(parseRosterSetting(''), DEFAULT_TEAMS);
  assert.deepEqual(parseRosterSetting('   '), DEFAULT_TEAMS);
  assert.deepEqual(parseRosterSetting('{not json'), DEFAULT_TEAMS);
  assert.deepEqual(parseRosterSetting('[]'), DEFAULT_TEAMS);
  assert.deepEqual(parseRosterSetting('null'), DEFAULT_TEAMS);
});

test('normalizeRoster upper-cases and dedupes so casing cannot fork a team', () => {
  assert.deepEqual(normalizeRoster(['ufs1', ' UFS2 ', 'UFS1', '', null, 'UFS3']), ['UFS1', 'UFS2', 'UFS3']);
  assert.deepEqual(normalizeRoster('nope'), []);
  assert.deepEqual(normalizeRoster(null), []);
});

test('a roster team with no receipts still occupies a lane at zero', () => {
  const out = shapeTeamCollection({
    roster: ROSTER,
    teamRows: [{ team_key: 'UFS1', total: 100, receipts: 1, members: 2 }],
    froRows: [],
  });
  assert.equal(out.teams.length, 5, 'all five lanes must be present');
  assert.deepEqual(out.teams.map((t) => t.team), ['UFS1', 'UFS2', 'UFS3', 'UFS4', 'UFS5']);
  const zero = out.teams.find((t) => t.team === 'UFS5');
  assert.equal(zero.amount, 0);
  assert.equal(zero.receipts, 0);
  assert.equal(zero.share, 0);
});

test('ordering is by amount, and ties fall back to roster position not the alphabet', () => {
  // UFS5 ties UFS1 at 100. Alphabetical order would also happen to put UFS1
  // first here, so the tie-break is probed the other way round: equal amounts
  // across the roster must come out in roster order.
  const out = shapeTeamCollection({
    roster: ['UFS3', 'UFS1', 'UFS2'],
    teamRows: [
      { team_key: 'UFS3', total: 50, receipts: 1, members: 1 },
      { team_key: 'UFS1', total: 50, receipts: 1, members: 1 },
      { team_key: 'UFS2', total: 50, receipts: 1, members: 1 },
    ],
    froRows: [],
  });
  assert.deepEqual(out.teams.map((t) => t.team), ['UFS3', 'UFS1', 'UFS2']);
});

test('compareTeamLabels orders UFS9 before UFS10, which a plain string compare gets wrong', () => {
  const names = ['UFS10', 'UFS9', 'UFS1', 'UFS2'];
  assert.deepEqual([...names].sort(compareTeamLabels), ['UFS1', 'UFS2', 'UFS9', 'UFS10']);
  assert.ok('UFS10' < 'UFS9', 'the string-compare bug this guards is real');
  assert.equal(teamSortRank('UFS9').num, 9);
  assert.equal(teamSortRank('UFS10').num, 10);
  // A name with no trailing number sorts after every numbered one, not at NaN.
  assert.ok(teamSortRank('ZEBRA').num > teamSortRank('UFS99').num);
});

test('the No Team bucket is kept out of the race and out of the total', () => {
  const out = shapeTeamCollection({
    roster: ROSTER,
    teamRows: [
      { team_key: 'UFS1', total: 100, receipts: 1, members: 1 },
      { team_key: NO_TEAM_KEY, total: 40, receipts: 2, members: 2 },
    ],
    froRows: [],
  });
  assert.ok(!out.teams.some((t) => t.team === NO_TEAM_LABEL), 'No Team must not be a bar');
  assert.deepEqual(out.unassigned, { amount: 40, receipts: 2 });
  assert.equal(out.total, 100, 'total is the raced total, No Team excluded');
  assert.equal(teamLabel(NO_TEAM_KEY), NO_TEAM_LABEL);
});

test('an unrostered team value keeps its money as a flagged row instead of vanishing', () => {
  const out = shapeTeamCollection({
    roster: ROSTER,
    teamRows: [
      { team_key: 'UFS1', total: 100, receipts: 1, members: 1 },
      { team_key: 'UFS9', total: 70, receipts: 1, members: 1 }, // e.g. a missed rename
    ],
    froRows: [],
  });
  const extra = out.teams.find((t) => t.team === 'UFS9');
  assert.ok(extra, 'the unrostered team must appear');
  assert.equal(extra.unrostered, true);
  assert.equal(extra.amount, 70);
  assert.equal(out.unrostered_count, 1);
  assert.equal(out.total, 170, 'money is preserved so the total still reconciles');
  assert.equal(out.teams.filter((t) => !t.unrostered).every((t) => t.unrostered === false), true);
});

test('unrostered rows sort after the roster on an amount tie', () => {
  const out = shapeTeamCollection({
    roster: ['UFS1'],
    teamRows: [
      { team_key: 'ZZZ', total: 50, receipts: 1, members: 1 },
      { team_key: 'UFS1', total: 50, receipts: 1, members: 1 },
    ],
    froRows: [],
  });
  assert.deepEqual(out.teams.map((t) => t.team), ['UFS1', 'ZZZ']);
});

test('an empty roster still reports every team found in the data', () => {
  const out = shapeTeamCollection({
    roster: [],
    teamRows: [{ team_key: 'UFS1', total: 10, receipts: 1, members: 1 }],
    froRows: [],
  });
  assert.deepEqual(out.teams.map((t) => t.team), ['UFS1']);
  assert.equal(out.teams[0].unrostered, true);
  assert.equal(out.unrostered_count, 1);
});

test('shares add up to 100 across the board', () => {
  const out = shapeTeamCollection({
    roster: ROSTER,
    teamRows: [
      { team_key: 'UFS1', total: 128400, receipts: 61, members: 5 },
      { team_key: 'UFS2', total: 96400, receipts: 44, members: 6 },
      { team_key: 'UFS3', total: 62100, receipts: 29, members: 4 },
      { team_key: 'UFS4', total: 31700, receipts: 17, members: 4 },
      { team_key: 'UFS5', total: 10400, receipts: 6, members: 3 },
    ],
    froRows: [],
  });
  const sum = out.teams.reduce((s, t) => s + t.share, 0);
  assert.equal(out.teams[0].team, 'UFS1');
  assert.equal(out.teams[0].share, 39);
  assert.equal(out.total, 329000);
  assert.ok(Math.abs(sum - 100) < 0.5, `shares summed to ${sum}`);
});

test('a zero total divides safely and every share is zero', () => {
  const out = shapeTeamCollection({ roster: ROSTER, teamRows: [], froRows: [] });
  assert.equal(out.total, 0);
  assert.ok(out.teams.every((t) => t.share === 0));
  assert.equal(out.teams.length, 5);
});

test('top_fro credits the highest-collecting FRO in the team, ties by name', () => {
  const out = shapeTeamCollection({
    roster: ['UFS1'],
    teamRows: [{ team_key: 'UFS1', total: 200, receipts: 4, members: 3 }],
    froRows: [
      { team_key: 'UFS1', fro_worker_id: 'a', name: 'Zoya', total: 90 },
      { team_key: 'UFS1', fro_worker_id: 'b', name: 'Amit', total: 110 },
      { team_key: 'UFS1', fro_worker_id: 'c', name: 'Bejoy', total: 0 },
    ],
  });
  assert.deepEqual(out.teams[0].top_fro, { id: 'b', name: 'Amit', amount: 110 });

  const tie = shapeTeamCollection({
    roster: ['UFS1'],
    teamRows: [{ team_key: 'UFS1', total: 200, receipts: 2, members: 2 }],
    froRows: [
      { team_key: 'UFS1', fro_worker_id: 'b', name: 'Zoya', total: 100 },
      { team_key: 'UFS1', fro_worker_id: 'a', name: 'Amit', total: 100 },
    ],
  });
  assert.equal(tie.teams[0].top_fro.name, 'Amit', 'tie breaks on name so the pick is deterministic');
});

test('a No Team FRO never becomes a top_fro credit', () => {
  const out = shapeTeamCollection({
    roster: ['UFS1'],
    teamRows: [
      { team_key: 'UFS1', total: 10, receipts: 1, members: 1 },
      { team_key: NO_TEAM_KEY, total: 999, receipts: 3, members: 1 },
    ],
    froRows: [{ team_key: NO_TEAM_KEY, fro_worker_id: 'z', name: 'Ghost', total: 999 }],
  });
  assert.equal(out.teams[0].top_fro, null);
  assert.equal(out.unassigned.amount, 999);
});

test('the raced total plus the No Team bucket equals all money found in the data', () => {
  // The reconciliation invariant the dashboard depends on: the card sits directly
  // under the Collection card, so every rupee has to be accounted for somewhere.
  // `total` is what the board races; `unassigned` is what it footnotes. They must
  // sum to the raw aggregate - otherwise the two cards visibly disagree and the
  // only explanation on screen is "somewhere else".
  const out = shapeTeamCollection({
    roster: ROSTER,
    teamRows: [
      { team_key: 'UFS1', total: 128400, receipts: 61, members: 5 },
      { team_key: 'UFS3', total: 62100, receipts: 29, members: 4 },
      { team_key: 'UFS9', total: 7700, receipts: 4, members: 2 },  // unrostered
      { team_key: NO_TEAM_KEY, total: 9100, receipts: 7, members: 3 },
    ],
    froRows: [],
  });
  const raw = 128400 + 62100 + 7700 + 9100;
  assert.equal(out.total, 198200, 'board total excludes No Team');
  assert.equal(out.total + out.unassigned.amount, raw, 'nothing may go missing');
});

test('a missing workers row still keeps its receipt money, as No Team', () => {
  // workers is LEFT joined (unlike the Collection card) precisely so this case
  // surfaces as an explained "outside any team" amount instead of vanishing and
  // making this card read lower than the Collection card above it.
  const out = shapeTeamCollection({
    roster: ROSTER,
    teamRows: [
      { team_key: 'UFS1', total: 500, receipts: 2, members: 1 },
      { team_key: NO_TEAM_KEY, total: 250, receipts: 1, members: 0 },
    ],
    froRows: [{ team_key: NO_TEAM_KEY, fro_worker_id: 'orphan-1', name: null, total: 250 }],
  });
  assert.equal(out.total + out.unassigned.amount, 750);
  assert.equal(out.teams[0].top_fro, null, 'an unnamed orphan FRO cannot be credited');
});

test('junk rows are skipped instead of producing NaN lanes', () => {
  const out = shapeTeamCollection({
    roster: ['UFS1'],
    teamRows: [
      null,
      { team_key: '' },
      { team_key: 'UFS1', total: 'not a number', receipts: null, members: undefined },
    ],
    froRows: [null, { team_key: '' }, { team_key: 'UFS1' }],
  });
  assert.equal(out.teams.length, 1);
  assert.equal(out.teams[0].amount, 0);
  assert.equal(out.teams[0].receipts, 0);
  assert.equal(out.teams[0].members, 0);
  assert.equal(out.total, 0);
  assert.ok(Number.isFinite(out.teams[0].top_fro.amount));
});

test('money is rounded to paise so shares cannot drift off 100', () => {
  const out = shapeTeamCollection({
    roster: ['UFS1', 'UFS2', 'UFS3'],
    teamRows: [
      { team_key: 'UFS1', total: 10.005, receipts: 1, members: 1 },
      { team_key: 'UFS2', total: 20.005, receipts: 1, members: 1 },
      { team_key: 'UFS3', total: 30.005, receipts: 1, members: 1 },
    ],
    froRows: [],
  });
  assert.equal(out.total, 60.03, '10.005 / 20.005 / 30.005 each round to x.01');
  const sum = out.teams.reduce((s, t) => s + t.share, 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `shares summed to ${sum}`);
});