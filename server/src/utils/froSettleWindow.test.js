// The settle-in grace, and the window it hands over to.
//
// The disposition window used to be opened by the FRO's first recorded action, so
// logging in bought nothing and the clock stayed frozen until the FRO had already
// done the work they were being timed on. With no disposition_due_at on the row
// there was no lapse for any reader to derive an idle period from, so that first
// hour was simply free.
//
// Three minutes to settle are now granted on first presence of the IST day, and
// the ordinary 4-minute window arms itself the moment that runs out. These tests
// pin the two handshakes, and — more importantly — every case where the server
// must NOT hand out time, because each of those is a way this change becomes a
// billing bug rather than a fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPOSITION_WINDOW_SECONDS,
  SETTLE_SECONDS,
  idlePeriodStartMs,
  isIdleNow,
  liveIdleSeconds,
  settleGrant,
  settleSecondsLeft,
  settleUntilMs,
  settleWindowArm,
} from './froIdle.js';

// Fixed clock so nothing here depends on the wall clock. 2026-09-29T12:00:00Z is
// 17:30 IST — mid-afternoon on the working day, inside any plausible shift.
const NOW = Date.parse('2026-09-29T12:00:00Z');
const SHIFT = { startMs: NOW - 8 * 3600 * 1000, endMs: NOW + 4 * 3600 * 1000 };
const ago = (ms) => new Date(NOW - ms).toISOString();
const inMs = (ms) => new Date(NOW + ms).toISOString();

// Yesterday, same wall time. Used for the "left over from another day" cases.
const YESTERDAY = new Date(NOW - 24 * 3600 * 1000).toISOString();

test('the grace is three minutes, and the window it hands over to is still four', () => {
  assert.equal(SETTLE_SECONDS, 180);
  // The point of the change: a grace BEFORE the window, never a shorter window.
  assert.equal(DISPOSITION_WINDOW_SECONDS, 240);
});

test('first presence of the day is granted a grace', () => {
  const granted = settleGrant({}, SHIFT, NOW);
  assert.ok(granted, 'a bare row with no deadline and no grace must be granted one');
  assert.equal(settleUntilMs({ settle_until: granted }, NOW), NOW + SETTLE_SECONDS * 1000);
});

test('the grace is granted once per day, never slid forward', () => {
  const granted = settleGrant({}, SHIFT, NOW);
  // Ten minutes later, still inside the same day: the row already has a grace, so
  // the next heartbeat must leave it alone. Re-granting here is the exploit —
  // it would hand out unlimited settling time on a single login.
  assert.equal(settleGrant({ settle_until: granted }, SHIFT, NOW + 10 * 60 * 1000), null);
});

test('a spent grace is not regranted either', () => {
  // Settle ran out 40 minutes ago and the FRO never recorded anything.
  const spent = ago(40 * 60 * 1000);
  assert.equal(settleGrant({ settle_until: spent }, SHIFT, NOW), null);
});

test('a grace from yesterday reads as no grace at all', () => {
  // The panel can be left open across midnight, and the rollover that clears a
  // day's counters lives on the write paths. Judging staleness by IST day here is
  // what stops yesterday's spent grace being carried into today.
  assert.equal(settleUntilMs({ settle_until: YESTERDAY }, NOW), NaN);
  assert.equal(settleGrant({ settle_until: YESTERDAY }, SHIFT, NOW).length > 0, true);
});

test('the window does not arm while the grace is still running', () => {
  const row = { settle_until: inMs(60 * 1000) };
  assert.equal(settleWindowArm(row, SHIFT, NOW), null);
});

test('once the grace runs out the ordinary 4-minute window arms', () => {
  const row = { settle_until: ago(1000) };
  const armed = settleWindowArm(row, SHIFT, NOW);
  assert.equal(settleUntilMs(row, NOW), NOW - 1000);
  assert.equal(armed, inMs(DISPOSITION_WINDOW_SECONDS * 1000 - 1000));
});

test('a late heartbeat cannot shorten the window the FRO was promised', () => {
  // Grace ran out two minutes ago but no heartbeat landed until now. The deadline
  // is measured from the grace's own expiry, not from now, so the FRO still gets
  // a full 4 minutes and the server's polling lag costs them nothing.
  const row = { settle_until: ago(120 * 1000) };
  assert.equal(settleWindowArm(row, SHIFT, NOW), inMs((DISPOSITION_WINDOW_SECONDS - 120) * 1000));
});

test('closing the panel during the grace and coming back buys nothing', () => {
  // Grace ended at T+3, the FRO closed the tab, and came back an hour later. They
  // are armed with a deadline that is already in the past, so they are billed from
  // T+3+4 rather than being handed a fresh 4 minutes on return. This is the whole
  // point: reopening the panel must not restart anything.
  const row = { settle_until: ago(57 * 60 * 1000) };
  const armed = settleWindowArm(row, SHIFT, NOW);
  assert.ok(armed);
  assert.ok(Date.parse(armed) < NOW, 'the armed deadline must already be in the past');
  // And the row reads as idle immediately, backdated to that deadline.
  assert.equal(isIdleNow({ ...row, disposition_due_at: armed }, SHIFT, NOW), true);
  assert.equal(idlePeriodStartMs({ ...row, disposition_due_at: armed }, NOW), Date.parse(armed));
});

test('the window never re-arms once it exists', () => {
  // The single most important guard. Re-arming on every heartbeat would slide the
  // deadline forward forever and the FRO could never lapse — which is precisely
  // the "timer resets itself to 4:00" bug this change exists to close.
  const row = { settle_until: ago(10 * 60 * 1000), disposition_due_at: inMs(3 * 60 * 1000) };
  assert.equal(settleWindowArm(row, SHIFT, NOW), null);
  assert.equal(settleGrant(row, SHIFT, NOW), null);
});

test('a FRO who is already idle is not re-armed behind their back', () => {
  // Idle for 25 minutes. The deadline is long gone but idle_since is set, so both
  // guards must stand down: re-arming here would silently forgive the idle.
  const row = { settle_until: ago(30 * 60 * 1000), idle_since: ago(25 * 60 * 1000), status: 'idle' };
  assert.equal(settleWindowArm(row, SHIFT, NOW), null);
  assert.equal(settleGrant(row, SHIFT, NOW), null);
});

test('a lapsed deadline with no idle_since yet still blocks arming', () => {
  // The window ran out but nothing has pushed the idle stamp yet. The deadline is
  // still on the row, and idlePeriodStartMs derives the period from it, so this
  // counts as an open idle and must not be re-armed.
  const row = { settle_until: ago(20 * 60 * 1000), disposition_due_at: ago(2 * 60 * 1000) };
  assert.equal(idlePeriodStartMs(row, NOW), Date.parse(row.disposition_due_at));
  assert.equal(settleWindowArm(row, SHIFT, NOW), null);
});

test('neither grace nor window is granted while the FRO is held', () => {
  // A meeting or an admin pause means the FRO is not at the desk, and the existing
  // freeze logic hands back a full window when it lifts. Arming during a freeze
  // would start a countdown against a frozen row.
  for (const held of [{ is_paused: true }, { status: 'meeting' }]) {
    assert.equal(settleGrant(held, SHIFT, NOW), null);
    assert.equal(settleWindowArm({ ...held, settle_until: ago(1000) }, SHIFT, NOW), null);
  }
});

test('neither grace nor window is granted outside the shift', () => {
  const closed = { startMs: NOW + 2 * 3600 * 1000, endMs: NOW + 10 * 3600 * 1000 };
  assert.equal(settleGrant({}, closed, NOW), null);
  assert.equal(settleWindowArm({ settle_until: ago(1000) }, closed, NOW), null);
});

test('a deadline left over from yesterday does not block a fresh grace', () => {
  // withoutStaleIdle normally clears this before the grant runs, but a path that
  // skipped it must still grant rather than leave the FRO on a dead clock all day.
  const row = { disposition_due_at: YESTERDAY };
  assert.ok(settleGrant(row, SHIFT, NOW));
});

test('the grace itself never accrues idle', () => {
  // The whole reason settle_until is its own column rather than a value parked in
  // disposition_due_at: every idle reader treats a lapsed deadline as a missed
  // disposition, so storing the grace there would bill the FRO at the exact moment
  // the grace was supposed to hand over to the window.
  const row = { settle_until: ago(10 * 60 * 1000) };
  assert.equal(isIdleNow(row, SHIFT, NOW), false);
  assert.equal(idlePeriodStartMs(row, NOW), NaN);
  assert.equal(liveIdleSeconds(row, SHIFT, NOW), 0);
});

test('seconds left on the grace is null when there is no grace', () => {
  // Null rather than 0, because 0 would be indistinguishable from a grace that has
  // just run out, and the two want different things on screen.
  assert.equal(settleSecondsLeft({}, NOW), null);
  assert.equal(settleSecondsLeft({ settle_until: ago(1000) }, NOW), 0);
  assert.equal(settleSecondsLeft({ settle_until: inMs(90 * 1000) }, NOW), 90);
  assert.equal(settleSecondsLeft({ settle_until: YESTERDAY }, NOW), null);
});

test('a full day, minute by minute, never leaves the FRO without a clock', () => {
  // The end-to-end shape: grace, then window, then idle backdated to the deadline.
  let row = {};
  const granted = settleGrant(row, SHIFT, NOW);
  row = { ...row, settle_until: granted };

  // Mid-grace: no window, not idle, nothing billed.
  const midGrace = NOW + 60 * 1000;
  assert.equal(settleWindowArm(row, SHIFT, midGrace), null);
  assert.equal(isIdleNow(row, SHIFT, midGrace), false);

  // Grace spent: the window arms to a full 4 minutes.
  const atHandover = NOW + SETTLE_SECONDS * 1000;
  const due = settleWindowArm(row, SHIFT, atHandover);
  assert.equal(due, inMs(SETTLE_SECONDS * 1000 + DISPOSITION_WINDOW_SECONDS * 1000));
  row = { ...row, disposition_due_at: due };

  // Just before the deadline: still fine.
  assert.equal(isIdleNow(row, SHIFT, Date.parse(due) - 1000), false);
  // At the deadline: idle starts exactly there, not at the next heartbeat.
  const atDeadline = Date.parse(due);
  assert.equal(isIdleNow(row, SHIFT, atDeadline), true);
  assert.equal(idlePeriodStartMs(row, atDeadline), atDeadline);
  // Five minutes of silence later: five minutes billed, from the deadline.
  assert.equal(liveIdleSeconds(row, SHIFT, atDeadline + 5 * 60 * 1000), 300);
});
