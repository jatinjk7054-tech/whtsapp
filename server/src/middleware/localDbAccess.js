// Local development access to the AWS-hosted database.
//
// The database is an RDS Postgres instance that is publicly reachable but sits
// behind a VPC security group. When the backend runs on a laptop whose public
// IP is not yet in that security group, every query fails with "connection
// refused" — the usual fix was running scripts/open-db-access.mjs by hand, once
// per network, and remembering to undo it afterwards.
//
// This module automates that: on boot it authorizes exactly the machine's
// current public IP on the database port, and on shutdown it revokes the rule
// it created. Each rule is tagged with RULE_TAG so it is identifiable in the
// AWS console, and each boot also sweeps rules left behind by earlier sessions
// that were killed, crashed, or slept with the lid closed.
//
// Why a middleware (and not a boot-only hook): the ask was for a middleware in
// front of /api/*. That shape is only safe because ensureLocalDbAccess() is
// memoized — the AWS work happens exactly once per process and every later
// request reuses the settled result. Per-request authorize/revoke would be
// both slow and wrong, since security group changes take seconds to propagate.
//
// The middleware never fails a request. If AWS credentials are missing or the
// IAM policy lacks ec2:AuthorizeSecurityGroupIngress, the error is logged and
// the request proceeds — losing a permission should not 500 the whole local API.
//
// Env knobs:
//   LOCAL_DB_ACCESS=true               opt in; anything else is a no-op
//   LOCAL_DB_ACCESS_RULE_TTL_HOURS=12  age at which a leftover rule is swept
//   LOCAL_DB_ACCESS_REGION=            defaults to AWS_REGION or the RDS host
//   LOCAL_DB_ACCESS_PORT=5432          defaults to the DATABASE_URL port
//   LOCAL_DB_ACCESS_IP_URL=            public-IP lookup endpoint
//
// Required IAM permissions beyond the read-only ones the capacity panel uses:
//   rds:DescribeDBInstances, ec2:DescribeSecurityGroups,
//   ec2:AuthorizeSecurityGroupIngress, ec2:RevokeSecurityGroupIngress

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { EC2Client, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');

// Loaded here as well as in config/db.js so the module works when imported
// first (scripts/revoke-local-db-access.mjs) and never depends on import order.
dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

// Marks every rule this module owns. The sweeper matches on this prefix and
// nothing else, so it can never remove a rule a human created by hand.
export const RULE_TAG = 'ucs-local-dev:';

// Local notes file. AWS does not expose a creation timestamp on security group
// rules, so the age check cannot be done from the API alone — we record when we
// added each rule here. Gitignored.
const STATE_FILE = process.env.LOCAL_DB_ACCESS_STATE_FILE
  || path.join(BACKEND_ROOT, '.local-db-access.json');

const DEFAULT_TTL_HOURS = 12;
const DEFAULT_IP_URL = 'https://checkip.amazonaws.com';
// Never act on a rule wider than a single host, whatever the lookup returns.
const MAX_PREFIX_LENGTH = 32;

let awsConfigBuilt = null;
let ensurePromise = null;
let cleanupRegistered = false;
let myEntry = null; // the single rule this process owns, in memory

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests — no network, no AWS)
// ---------------------------------------------------------------------------

// Accepts only a plain dotted-quad public IPv4. Rejects anything with a prefix
// (the "open to everyone" case we must never create), and rejects private /
// loopback / link-local / reserved ranges so a misconfigured lookup can never
// point the rule at something meaningless.
export function isSafePublicIpv4(value) {
  if (typeof value !== 'string') return false;
  const ip = value.trim();
  if (ip.includes('/')) return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

export function cidrForIp(ip) {
  return `${ip}/32`;
}

export function isExpired(addedAt, ttlHours = DEFAULT_TTL_HOURS, now = Date.now()) {
  if (!addedAt) return true; // unknown age: treat as expired rather than leaking
  const ageMs = now - new Date(addedAt).getTime();
  if (!Number.isFinite(ageMs)) return true;
  const ttl = Number(ttlHours) > 0 ? Number(ttlHours) : DEFAULT_TTL_HOURS;
  return ageMs > ttl * 3600 * 1000;
}

// Decides which tagged rules to drop.
//
// A rule for the current machine's own address is only dropped when we have a
// recorded age and it is genuinely past the TTL. An *unknown* age is not a
// reason to drop it: the authorize call that follows is idempotent, and the
// shutdown revoke owns its cleanup. Treating unknown as expired here would
// revoke and immediately re-create the rule on every process restart (nodemon
// does that on every file save), briefly dropping access for no benefit.
//
// Rules for any other address are dropped whether or not their age is known —
// they cannot belong to this process, and we would rather not leak them.
export function selectRulesToRevoke(rules, { currentCidr, ttlHours, now = Date.now() } = {}) {
  const doomed = [];
  for (const rule of rules || []) {
    if (!rule || !rule.description || !rule.description.startsWith(RULE_TAG)) continue;
    if (!rule.cidr) continue;
    if (currentCidr && rule.cidr === currentCidr) {
      if (rule.addedAt && isExpired(rule.addedAt, ttlHours, now)) doomed.push(rule);
      continue;
    }
    doomed.push(rule);
  }
  return doomed;
}

export function parseRdsHost(connectionString) {
  try {
    const host = new URL(String(connectionString).replace(/^postgres:\/\//, 'postgres://')).hostname;
    const parts = host.split('.');
    const n = parts.length;
    if (n < 4 || parts[n - 1] !== 'com' || parts[n - 2] !== 'amazonaws' || parts[n - 3] !== 'rds') return null;
    const region = parts[n - 4];
    return { identifier: parts[0], region: /^[a-z]{2}(-[a-z]+)+-\d$/.test(region) ? region : null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

function writeState(rules) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify({ rules }, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[localDbAccess] could not write state file ${STATE_FILE}: ${err.message}`);
  }
}

// Drops entries whose process is gone, or that are past their TTL with no live
// owner, so the file cannot accumulate dead history.
function pruneState(stale) {
  const live = os.hostname();
  const kept = readState().filter((r) => {
    if (stale.some((s) => s.cidr === r.cidr && s.groupId === r.groupId)) return false;
    if (r.host !== live) return false;
    if (r.pid === process.pid) return true;
    try { process.kill(Number(r.pid), 0); return true; } catch { return false; }
  });
  writeState(kept);
  return kept;
}

// ---------------------------------------------------------------------------
// AWS plumbing
// ---------------------------------------------------------------------------

function isEnabled() {
  if (process.env.VERCEL) return false;
  if (String(process.env.LOCAL_DB_ACCESS || '').toLowerCase() !== 'true') return false;
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function buildClients() {
  if (awsConfigBuilt) return awsConfigBuilt;
  const host = parseRdsHost(process.env.DATABASE_URL || '');
  const identifier = process.env.RDS_DB_INSTANCE_IDENTIFIER || process.env.RDS_INSTANCE_IDENTIFIER || (host && host.identifier);
  if (!identifier) {
    awsConfigBuilt = { error: 'set RDS_DB_INSTANCE_IDENTIFIER (or point DATABASE_URL at an *.rds.amazonaws.com host)' };
    return awsConfigBuilt;
  }
  let port = Number(process.env.LOCAL_DB_ACCESS_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    port = 5432;
    try {
      const fromUrl = Number(new URL(String(process.env.DATABASE_URL).replace(/^postgres:\/\//, 'postgres://')).port);
      if (Number.isInteger(fromUrl) && fromUrl > 0) port = fromUrl;
    } catch { /* keep 5432 */ }
  }
  const region = process.env.LOCAL_DB_ACCESS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || (host && host.region) || 'ap-south-1';
  const config = {
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  };
  awsConfigBuilt = { identifier, port, region, ec2: new EC2Client(config), rds: new RDSClient(config) };
  return awsConfigBuilt;
}

async function fetchPublicIp(ipUrl) {
  const res = await fetch(ipUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${ipUrl} responded ${res.status}`);
  return (await res.text()).trim();
}

async function describeSecurityGroup(ec2, groupId) {
  const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
  return (res.SecurityGroups && res.SecurityGroups[0]) || null;
}

function taggedIngress(sg, port) {
  const out = [];
  for (const perm of (sg && sg.IpPermissions) || []) {
    const fromPort = Number(perm.FromPort);
    const toPort = Number(perm.ToPort);
    if (perm.IpProtocol !== 'tcp' || fromPort > port || toPort < port) continue;
    for (const range of perm.IpRanges || []) {
      if (!range.CidrIp) continue;
      if (range.Description && range.Description.startsWith(RULE_TAG)) {
        out.push({ cidr: range.CidrIp, description: range.Description });
      }
    }
  }
  return out;
}

function ingressPermission(cidr, port, description) {
  return {
    IpProtocol: 'tcp',
    FromPort: port,
    ToPort: port,
    IpRanges: [{ CidrIp: cidr, Description: description }],
  };
}

async function authorize(ec2, groupId, cidr, port, description) {
  try {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [ingressPermission(cidr, port, description)],
    }));
    return 'created';
  } catch (err) {
    if (/duplicate|already exists/i.test(String(err && err.message))) return 'existing';
    throw err;
  }
}

// Deliberately omits the Description. Revoke matches on protocol, port range
// and CIDR; the description is metadata and is not part of the match. A rule
// that already existed from an earlier process carries that process's
// description, so matching on it would make the shutdown revoke unreliable.
async function revoke(ec2, groupId, cidr, port, description) {
  await ec2.send(new RevokeSecurityGroupIngressCommand({
    GroupId: groupId,
    IpPermissions: [{
      IpProtocol: 'tcp',
      FromPort: port,
      ToPort: port,
      IpRanges: [{ CidrIp: cidr }],
    }],
  }));
}

// Kept free of the pid so the text is identical across restarts: a rule that
// already exists therefore keeps matching the description this process would
// write, and anyone auditing the group sees one stable owner per machine
// instead of a new pid on every nodemon restart.
function describeRule(cidr, port) {
  const user = os.userInfo().username;
  return `${RULE_TAG}${user}@${os.hostname()} port=${port} (added by localDbAccess, safe to delete)`;
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

// Removes rules this tool created that are not the current machine's live rule.
// Returns the descriptions of anything it removed, for logging.
async function sweep(ec2, groupId, port, ttlHours, keepCidr) {
  const removed = [];
  const sg = await describeSecurityGroup(ec2, groupId);
  const live = taggedIngress(sg, port);
  const known = pruneState([]);

  // Annotate each tagged rule with the age recorded locally, if we have one.
  const annotated = live.map((r) => {
    const match = known.find((k) => k.cidr === r.cidr && k.groupId === groupId);
    return { ...r, addedAt: match ? match.addedAt : null };
  });

  const doomed = selectRulesToRevoke(annotated, { currentCidr: keepCidr, ttlHours });
  for (const rule of doomed) {
    try {
      await revoke(ec2, groupId, rule.cidr, port, rule.description);
      removed.push(rule.cidr);
    } catch (err) {
      // A rule may already be gone, or another admin changed it underneath us.
      // Never let a cleanup failure block the dev server from booting.
      console.warn(`[localDbAccess] could not remove leftover rule ${rule.cidr}: ${err.message}`);
    }
  }

  if (removed.length) {
    writeState(known.filter((k) => !removed.includes(k.cidr)));
    console.log(`[localDbAccess] swept ${removed.length} stale rule(s) on ${groupId}: ${removed.join(', ')}`);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getLocalDbAccessStatus() {
  return {
    enabled: isEnabled(),
    rule: myEntry,
    stateFile: STATE_FILE,
    tag: RULE_TAG,
  };
}

// Runs the AWS work at most once per process. Safe to await directly (the boot
// sequence calls this before the first query) and safe to leave mounted as
// per-request middleware — the memoized promise is shared.
export async function ensureLocalDbAccess() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    if (!isEnabled()) return { ok: false, reason: 'disabled' };

    const { error, identifier, port, region, ec2, rds } = buildClients();
    if (error) {
      console.warn(`[localDbAccess] skipped: ${error}`);
      return { ok: false, reason: error };
    }

    const ipUrl = process.env.LOCAL_DB_ACCESS_IP_URL || DEFAULT_IP_URL;
    const ttlHours = Number(process.env.LOCAL_DB_ACCESS_RULE_TTL_HOURS) > 0
      ? Number(process.env.LOCAL_DB_ACCESS_RULE_TTL_HOURS)
      : DEFAULT_TTL_HOURS;

    let ip;
    try {
      ip = await fetchPublicIp(ipUrl);
    } catch (err) {
      console.warn(`[localDbAccess] skipped: could not determine your public IP (${err.message}).`);
      console.warn('[localDbAccess] If the database is unreachable, run scripts/open-db-access.mjs or start the SSH tunnel instead.');
      return { ok: false, reason: `public IP lookup failed: ${err.message}` };
    }
    if (!isSafePublicIpv4(ip)) {
      console.warn(`[localDbAccess] skipped: ${ipUrl} returned "${ip}", which is not a routable public IPv4 address. Refusing to open the database.`);
      return { ok: false, reason: `unsafe address "${ip}"` };
    }

    const desc = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
    const instance = desc.DBInstances && desc.DBInstances[0];
    if (!instance) {
      console.warn(`[localDbAccess] skipped: no RDS instance "${identifier}" in ${region}.`);
      return { ok: false, reason: `no RDS instance "${identifier}"` };
    }
    if (instance.PubliclyAccessible === false) {
      console.warn(`[localDbAccess] skipped: "${identifier}" is not publicly reachable, so opening a security group will not help.`);
      console.warn('[localDbAccess] Use the SSH tunnel instead: powershell -File backend/start-local-db-tunnel.ps1, then set DATABASE_URL to localhost.');
      return { ok: false, reason: 'instance is not publicly accessible' };
    }
    const groupId = instance.VpcSecurityGroups && instance.VpcSecurityGroups[0] && instance.VpcSecurityGroups[0].VpcSecurityGroupId;
    if (!groupId) {
      console.warn(`[localDbAccess] skipped: could not resolve a VPC security group for "${identifier}".`);
      return { ok: false, reason: 'no VPC security group' };
    }

    const cidr = cidrForIp(ip);
    const description = describeRule(cidr, port);

    // Clear anything left over from previous sessions first, so this boot does
    // not inherit an expired rule for the same machine.
    await sweep(ec2, groupId, port, ttlHours, cidr).catch((err) => {
      console.warn(`[localDbAccess] stale-rule sweep failed (continuing): ${err.message}`);
    });

    const outcome = await authorize(ec2, groupId, cidr, port, description);
    myEntry = { cidr, groupId, port, description, pid: process.pid, host: os.hostname(), addedAt: new Date().toISOString() };
    writeState([...readState().filter((r) => !(r.cidr === cidr && r.groupId === groupId)), myEntry]);

    console.log(`[localDbAccess] ${outcome === 'created' ? 'opened' : 'confirmed'} ${groupId} for ${cidr} on port ${port} (${identifier} @ ${region})`);
    console.log('[localDbAccess] this rule is removed automatically when you stop the server.');
    return { ok: true, ...myEntry, outcome };
  })().catch((err) => {
    // Never let an AWS failure abort the boot — the API must still come up.
    console.warn(`[localDbAccess] unavailable: ${err.message}`);
    console.warn('[localDbAccess] The server is still starting, but database access may fail until this is fixed.');
    return { ok: false, reason: err.message };
  });
  return ensurePromise;
}

// Removes the rule this process created. Only ever touches our own entry, so a
// nodemon restart cannot revoke the rule its replacement just added.
export async function revokeLocalDbAccess() {
  const entry = myEntry;
  if (!entry) return { ok: true, reason: 'nothing to revoke' };
  myEntry = null;
  try {
    const { error, ec2 } = buildClients();
    if (error) return { ok: false, reason: error };
    await revoke(ec2, entry.groupId, entry.cidr, entry.port, entry.description);
    writeState(readState().filter((r) => !(r.cidr === entry.cidr && r.groupId === entry.groupId)));
    console.log(`[localDbAccess] closed ${entry.groupId} for ${entry.cidr}.`);
    return { ok: true };
  } catch (err) {
    if (/not found|InvalidPermission\.NotFound/i.test(String(err && err.message))) {
      console.log('[localDbAccess] rule was already gone.');
      return { ok: true };
    }
    console.error(`[localDbAccess] FAILED to close ${entry.cidr}: ${err.message}`);
    console.error('[localDbAccess] Run: node scripts/revoke-local-db-access.mjs');
    return { ok: false, reason: err.message };
  }
}

// True while this process owns an open rule, i.e. there is something to clean up.
export function hasLocalDbRule() {
  return myEntry !== null;
}

// Revokes our rule and reports whether the caller now owns the exit.
// Returns false when nothing of ours is open, so the caller can leave the signal
// completely alone.
export async function shutdownLocalDbAccess() {
  if (!myEntry) return false;
  await revokeLocalDbAccess();
  return true;
}

// Revoke, then exit. A hard timeout guarantees the process exits even if the
// AWS call hangs.
export function registerLocalDbAccessCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const hardExitMs = 8000;

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.once(signal, () => {
      // The overwhelmingly common case, including every run on the production
      // host: no rule of ours is open. Detach and re-raise immediately so the
      // signal behaves exactly as if this handler had never been installed.
      // PM2 must keep seeing a signalled death, otherwise a restart request
      // would look like a clean exit and the backend would not come back.
      if (!hasLocalDbRule()) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
        return;
      }

      const timer = setTimeout(() => process.exit(1), hardExitMs);
      shutdownLocalDbAccess()
        .catch(() => {})
        .then((handled) => {
          clearTimeout(timer);
          if (!handled) {
            process.removeAllListeners(signal);
            process.kill(process.pid, signal);
            return;
          }
          // We owned a rule and it is now closed, so a normal exit is correct.
          process.exit(0);
        });
    });
  }

  // A normal exit that never saw a signal still should not leave the rule open.
  process.once('beforeExit', () => { revokeLocalDbAccess().catch(() => {}); });
}

// Removes every rule this tool ever created for the configured instance, for
// when a hard kill or a closed laptop left one behind. Exported so
// scripts/revoke-local-db-access.mjs shares this logic instead of duplicating
// the tagging and matching rules.
export async function revokeAllLocalDbAccess() {
  const { error, identifier, port, ec2, rds } = buildClients();
  if (error) return { ok: false, reason: error };

  const desc = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
  const instance = desc.DBInstances && desc.DBInstances[0];
  if (!instance) return { ok: false, reason: `no RDS instance "${identifier}"` };
  const groupId = instance.VpcSecurityGroups && instance.VpcSecurityGroups[0] && instance.VpcSecurityGroups[0].VpcSecurityGroupId;
  if (!groupId) return { ok: false, reason: 'no VPC security group' };

  const sg = await describeSecurityGroup(ec2, groupId);
  const live = taggedIngress(sg, port);
  if (live.length === 0) {
    writeState([]);
    myEntry = null;
    return { ok: true, groupId, removed: [], message: `No ${RULE_TAG}* rules on port ${port} — nothing to do.` };
  }

  const removed = [];
  const failed = [];
  for (const rule of live) {
    try {
      await revoke(ec2, groupId, rule.cidr, port, rule.description);
      removed.push(rule.cidr);
    } catch (err) {
      if (/not found|InvalidPermission\.NotFound/i.test(String(err && err.message))) {
        removed.push(rule.cidr);
        continue;
      }
      failed.push({ cidr: rule.cidr, reason: err.message });
    }
  }

  writeState([]);
  myEntry = null;
  return { ok: failed.length === 0, groupId, removed, failed };
}

// The Express middleware. Delegates to the memoized ensure, and always calls
// next() so a missing IAM permission can never break the request.
export function localDbAccess(req, res, next) {
  ensureLocalDbAccess()
    .catch((err) => console.warn(`[localDbAccess] ${err.message}`))
    .then(() => next());
}
