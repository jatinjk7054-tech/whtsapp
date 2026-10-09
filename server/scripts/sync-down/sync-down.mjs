import { execFileSync, execSync } from 'child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND_DIR, '.env') });

// ---------------------------------------------------------------------------
// Config (overridable via backend/.env)
// ---------------------------------------------------------------------------
const DOWN_DB_URL = process.env.SYNC_DOWN_DATABASE_URL
  || 'postgres://ucs_admin:Sevak1432P@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/postgres';
const LOCAL_DB_URL = process.env.SYNC_DOWN_LOCAL_DATABASE_URL
  || process.env.LOCAL_BACKUP_DATABASE_URL
  || process.env.ADMIN_DATABASE_URL
  || 'postgres://postgres:Sevak1432P@localhost:5432/postgres';
const MEDIA_DIR = process.env.LOCAL_MEDIA_DIR || 'D:\\UcsCrmMedia';
const S3_BUCKET = process.env.S3_BUCKET || 'ucs-crm-uploads-mumbai';
const REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';

const HAS_MEDIA = process.env.SYNC_DOWN_MEDIA !== 'false';
const HAS_DB = process.env.SYNC_DOWN_DB !== 'false';

const PG_DUMP_CANDIDATES = [
  process.env.PG_DUMP_PATH,
  'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
  'pg_dump',
].filter(Boolean);

const pgDump = PG_DUMP_CANDIDATES.find((p) => {
  try { execSync(`"${p}" --version`, { stdio: 'ignore' }); return true; } catch { return false; }
});

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: ['ignore', opts.silent ? 'ignore' : 'inherit', 'inherit'], ...opts });
}

// ---------------------------------------------------------------------------
// Detect + report the office public IP (so re-whitelisting is easy if pull fails)
// ---------------------------------------------------------------------------
function publicIP() {
  try {
    const out = execSync('powershell -NoProfile -Command "(Invoke-RestMethod https://api.ipify.org?format=json -TimeoutSec 15).ip"', { encoding: 'utf8' }).trim();
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1) Media: pull S3 -> local (incremental, only new/changed, never deletes local)
// ---------------------------------------------------------------------------
function syncMedia() {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  log(`[media] pulling s3://${S3_BUCKET}/ -> ${MEDIA_DIR} (incremental)`);
  const awsCli = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';
  run(awsCli, ['s3', 'sync', `s3://${S3_BUCKET}/`, MEDIA_DIR, '--region', REGION]);
  log('[media] done');
}

// ---------------------------------------------------------------------------
// 2) DB: pull RDS -> local (safe refresh: local snapshot first, stop backend,
//    restore, restart backend)
// ---------------------------------------------------------------------------
function syncDB() {
  const ip = publicIP();
  log(`[db] office public IP for RDS whitelist check: ${ip || 'UNKNOWN'}`);

  // Test if RDS is reachable before doing anything destructive
  let reachable = false;
  try {
    const r = execSync(
      `powershell -NoProfile -Command "(Test-NetConnection -ComputerName '${new URL(DOWN_DB_URL).hostname}' -Port 5432 -WarningAction SilentlyContinue).TcpTestSucceeded"`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim().toLowerCase();
    reachable = r === 'true';
  } catch { reachable = false; }

  if (!reachable) {
    log(`[db] RDS NOT reachable. Your public IP (${ip || '?'}) is probably not whitelisted in the RDS security group (sg-0947f3d87e6807617). Nothing was changed.`);
    throw new Error('RDS unreachable - check security-group whitelist');
  }

  const tmp = path.join(os.tmpdir(), 'ucs-crm-sync-down');
  mkdirSync(tmp, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dump = path.join(tmp, `aws-${stamp}.dump`);
  const localBackup = path.join(tmp, `local-before-${stamp}.dump`);

  log('[db] RDS reachable - starting pull');

  // a) Dump RDS production DB
  log(`[db] dumping RDS -> ${dump}`);
  run(pgDump, ['--no-owner', '--no-privileges', '--format=custom', `--file=${dump}`, `--dbname=${DOWN_DB_URL}`]);

  // b) Backup current local DB (safety)
  log(`[db] backing up current local DB -> ${localBackup}`);
  run(pgDump, ['--no-owner', '--no-privileges', '--format=custom', `--file=${localBackup}`, `--dbname=${LOCAL_DB_URL}`]);

  log('[db] local backup succeeded deferring write of restored data');

  // c) Stop backend so restore doesn't collide
  stopBackend();
  // d) Terminate other sessions on the local target DB
  terminateSessions(LOCAL_DB_URL);

  // e) Restore RDS dump INTO local (drop existing objects + reload)
  log('[db] restoring RDS dump into local');
  const pgRestore = (process.env.PG_RESTORE_PATH
    || pgDump.replace('pg_dump.exe', 'pg_restore.exe').replace('pg_dump', 'pg_restore'));
  run(pgRestore, ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error',
    '--dbname=' + LOCAL_DB_URL, dump]);
  log('[db] restore complete');

  // f) Restart backend
  startBackend();
  log('[db] backend restarted');
}

// ---------------------------------------------------------------------------
// Backend control (find the process on port 5000)
// ---------------------------------------------------------------------------
function backendPids() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue).OwningProcess -join \',\'"',
      { encoding: 'utf8' }
    ).trim();
    return out ? out.split(',').filter(Boolean).map(Number) : [];
  } catch { return []; }
}

function stopBackend() {
  const pids = backendPids();
  for (const pid of pids) {
    log(`[backend] stopping PID ${pid}`);
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already dead */ }
  }
  execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' });
}

function startBackend() {
  log('[backend] starting node src/index.js');
  run('powershell', [
    '-NoProfile', '-Command',
    `Start-Process -FilePath 'C:\\Program Files\\nodejs\\node.exe' -ArgumentList 'src/index.js' -WorkingDirectory '${BACKEND_DIR}' -WindowStyle Hidden`,
  ]);
  let up = false;
  for (let i = 0; i < 10; i++) {
    execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' });
    try {
      const h = execSync('powershell -NoProfile -Command "(Invoke-RestMethod http://192.168.1.60:5000/api/health -TimeoutSec 5).status"', { encoding: 'utf8' }).trim().toLowerCase();
      if (h === 'ok') { up = true; break; }
    } catch { /* not up yet */ }
  }
  if (!up) log('[backend] WARNING: backend did not report healthy within timeout');
  else log('[backend] backend healthy');
}

// ---------------------------------------------------------------------------
// Terminate sessions on a {user:pass@host:port/db} URL
// ---------------------------------------------------------------------------
function terminateSessions(dbUrl) {
  const u = new URL(dbUrl);
  const host = u.hostname, port = u.port || 5432, db = (u.pathname || '').replace(/^\//, '') || 'postgres';
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const psql = process.env.PSQL_PATH || 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe';
  const prev = process.env.PGPASSWORD;
  process.env.PGPASSWORD = pass;
  try {
    execFileSync(psql, ['-h', host, '-p', String(port), '-U', user, '-d', db, '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid();`],
      { stdio: 'ignore' });
    log('[db] terminated other sessions on local DB');
  } catch { log('[db] (no other sessions, or could not terminate - continuing)'); }
  if (prev === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = prev;
}

// ---------------------------------------------------------------------------
function main() {
  log('=== sync-down start ===');
  // Public IP pre-check (informational)
  const ip = publicIP();
  log(`public IP: ${ip || 'UNKNOWN'}`);

  let mediaOk = true, dbOk = true;
  if (HAS_DB) {
    try { syncDB(); } catch (e) {
      dbOk = false;
      log(`[db] FAILED: ${e && e.message ? e.message : e}`);
    }
  } else log('[db] skipped (SYNC_DOWN_DB=false)');

  if (HAS_MEDIA) {
    try { syncMedia(); } catch (e) {
      mediaOk = false;
      log(`[media] FAILED: ${e && e.message ? e.message : e}`);
    }
  } else log('[media] skipped (SYNC_DOWN_MEDIA=false)');

  if (dbOk && mediaOk) log('=== sync-down OK ===');
  else { log('=== sync-down COMPLETED WITH ERRORS ==='); process.exitCode = 1; }
}

main();
