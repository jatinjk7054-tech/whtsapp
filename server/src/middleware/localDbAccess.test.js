import test from 'node:test';
import assert from 'node:assert/strict';

import { RULE_TAG, isSafePublicIpv4, cidrForIp, isExpired, selectRulesToRevoke, parseRdsHost, hasLocalDbRule, shutdownLocalDbAccess, getLocalDbAccessStatus, ensureLocalDbAccess } from './localDbAccess.js';

test('no rule is held before anything is authorized', () => {
  assert.equal(hasLocalDbRule(), false, 'a fresh module must not claim to own a rule');
});

test('shutdown reports handled=false when no rule is open, so the signal is not swallowed', async () => {
  // Regression: this handler is also installed on the production host, where no
  // rule is ever open. It must leave SIGTERM alone so PM2 still restarts the
  // backend instead of seeing a clean exit.
  const handled = await shutdownLocalDbAccess();
  assert.equal(handled, false, 'must not intercept the signal when nothing is open');
});

test('ensure is a no-op while disabled and does not open a rule', async () => {
  // LOCAL_DB_ACCESS is false in the checked-in .env.example; if a developer has
  // it enabled, only assert the shape rather than touching AWS.
  if (getLocalDbAccessStatus().enabled) return;
  const result = await ensureLocalDbAccess();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(hasLocalDbRule(), false, 'disabled mode must never open a rule');
});

test('isSafePublicIpv4 accepts routable public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.45', '103.21.244.1', '49.207.180.9']) {
    assert.equal(isSafePublicIpv4(ip), true, `${ip} should be accepted`);
  }
});

test('isSafePublicIpv4 rejects anything carrying a prefix', () => {
  // The failure mode that would expose the production database to the world.
  for (const bad of ['0.0.0.0/0', '8.8.8.8/32', '8.8.8.8/24', '::/0']) {
    assert.equal(isSafePublicIpv4(bad), false, `${bad} should be rejected`);
  }
});

test('isSafePublicIpv4 rejects private, loopback, link-local and reserved ranges', () => {
  for (const bad of [
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '127.0.0.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isSafePublicIpv4(bad), false, `${bad} should be rejected`);
  }
});

test('isSafePublicIpv4 rejects malformed input', () => {
  for (const bad of ['', '   ', '8.8.8', '8.8.8.8.8', '8.8.8.256', 'a.b.c.d', '8.8.8.-1', '8.8.8.8a', '::1', null, undefined, 1234, {}]) {
    assert.equal(isSafePublicIpv4(bad), false, `${String(bad)} should be rejected`);
  }
});

test('cidrForIp pins a single host', () => {
  assert.equal(cidrForIp('8.8.8.8'), '8.8.8.8/32');
});

test('isExpired compares the recorded age against the ttl', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();

  assert.equal(isExpired(hoursAgo(1), 12, now), false, '1 hour old is inside a 12 hour ttl');
  assert.equal(isExpired(hoursAgo(11), 12, now), false, '11 hours old is inside a 12 hour ttl');
  assert.equal(isExpired(hoursAgo(13), 12, now), true, '13 hours old is past a 12 hour ttl');
  // The ttl is a minimum lifetime: a rule is only swept once it is strictly
  // older than the window, so a session that is exactly at the limit keeps its
  // rule for one more tick rather than being cut off mid-boot.
  assert.equal(isExpired(hoursAgo(1), 1, now), false, 'exactly at the ttl still counts as live');
});

test('isExpired treats an unknown or unparsable age as expired', () => {
  // Leaking is the worse failure here, so no record means "clean it up".
  assert.equal(isExpired(null, 12, Date.now()), true);
  assert.equal(isExpired(undefined, 12, Date.now()), true);
  assert.equal(isExpired('not-a-date', 12, Date.now()), true);
});

test('isExpired falls back to the default ttl when given a nonsense value', () => {
  const now = Date.now();
  const recent = new Date(now - 60 * 1000).toISOString();
  assert.equal(isExpired(recent, 0, now), false);
  assert.equal(isExpired(recent, -5, now), false);
  assert.equal(isExpired(recent, 'abc', now), false);
});

test('selectRulesToRevoke keeps a live current-machine rule', () => {
  const now = Date.now();
  const rules = [{
    cidr: '8.8.8.8/32',
    description: `${RULE_TAG}dev@PC pid=1 port=5432 (added by localDbAccess, safe to delete)`,
    addedAt: new Date(now - 60 * 1000).toISOString(),
  }];
  const doomed = selectRulesToRevoke(rules, { currentCidr: '8.8.8.8/32', ttlHours: 12, now });
  assert.deepEqual(doomed, [], 'a fresh rule for this machine must survive');
});

test('selectRulesToRevoke drops an expired rule for the current machine', () => {
  const now = Date.now();
  const rules = [{
    cidr: '8.8.8.8/32',
    description: `${RULE_TAG}dev@PC pid=1 port=5432 (added by localDbAccess, safe to delete)`,
    addedAt: new Date(now - 20 * 3600 * 1000).toISOString(),
  }];
  const doomed = selectRulesToRevoke(rules, { currentCidr: '8.8.8.8/32', ttlHours: 12, now });
  assert.equal(doomed.length, 1, 'a rule past its ttl must be swept');
});

test('selectRulesToRevoke drops rules belonging to other addresses', () => {
  const now = Date.now();
  const addedAt = new Date(now - 60 * 1000).toISOString();
  const rules = [
    { cidr: '1.2.3.4/32', description: `${RULE_TAG}a@LAPTOP pid=9 port=5432 (added by localDbAccess, safe to delete)`, addedAt },
    { cidr: '5.6.7.8/32', description: `${RULE_TAG}b@OTHER pid=11 port=5432 (added by localDbAccess, safe to delete)`, addedAt },
  ];
  const doomed = selectRulesToRevoke(rules, { currentCidr: '8.8.8.8/32', ttlHours: 12, now });
  assert.equal(doomed.length, 2, 'rules for other machines must be swept');
});

test('selectRulesToRevoke keeps a current-machine rule whose age is unknown', () => {
  // Regression: a previous process recorded the rule, then died, so its state
  // entry (and therefore the age) is gone. The rule belongs to this machine, so
  // it must survive — otherwise every nodemon restart would revoke and
  // immediately re-create the rule, briefly dropping access.
  const now = Date.now();
  const rules = [{
    cidr: '8.8.8.8/32',
    description: `${RULE_TAG}dev@PC pid=1 port=5432 (added by localDbAccess, safe to delete)`,
    addedAt: null,
  }];
  const doomed = selectRulesToRevoke(rules, { currentCidr: '8.8.8.8/32', ttlHours: 12, now });
  assert.deepEqual(doomed, [], 'own rule with an unknown age must be kept, not churned');
});

test('selectRulesToRevoke still drops another address whose age is unknown', () => {
  // Unknown age is only a reason to keep the rule when it is our own address.
  const rules = [{
    cidr: '1.2.3.4/32',
    description: `${RULE_TAG}other@PC pid=9 port=5432 (added by localDbAccess, safe to delete)`,
    addedAt: null,
  }];
  const doomed = selectRulesToRevoke(rules, { currentCidr: '8.8.8.8/32', ttlHours: 12 });
  assert.equal(doomed.length, 1, 'a foreign rule with an unknown age must be swept');
});

test('selectRulesToRevoke never touches untagged rules', () => {
  const now = Date.now();
  const rules = [
    { cidr: '10.0.0.1/32', description: 'office vpn', addedAt: null },
    { cidr: '10.0.0.2/32', description: '', addedAt: null },
    { cidr: '10.0.0.3/32', description: 'something that merely mentions ucs-local-dev', addedAt: null },
    { cidr: '10.0.0.4/32', addedAt: null },
  ];
  const doomed = selectRulesToRevoke(rules, { currentCidr: '8.8.8.8/32', ttlHours: 12, now });
  assert.deepEqual(doomed, [], 'hand-made rules must be left alone');
});

test('selectRulesToRevoke survives junk input', () => {
  assert.deepEqual(selectRulesToRevoke(null, { currentCidr: '8.8.8.8/32' }), []);
  assert.deepEqual(selectRulesToRevoke(undefined, {}), []);
  assert.deepEqual(selectRulesToRevoke([null, { description: `${RULE_TAG}x` }], {}), [], 'entries with no cidr are skipped');
});

test('parseRdsHost pulls the instance id and region out of a connection string', () => {
  const parsed = parseRdsHost('postgres://user:pw@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/postgres');
  assert.equal(parsed.identifier, 'ucs-crm-db');
  assert.equal(parsed.region, 'ap-south-1');
});

test('parseRdsHost returns null for a non-RDS host', () => {
  assert.equal(parseRdsHost('postgres://user:pw@localhost:5432/postgres'), null);
  assert.equal(parseRdsHost('postgres://db.example.com:5432/postgres'), null);
  assert.equal(parseRdsHost(''), null);
  assert.equal(parseRdsHost(undefined), null);
});
