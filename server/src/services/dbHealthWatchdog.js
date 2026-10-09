import cron from 'node-cron';
import db from '../config/db.js';

// ---------------------------------------------------------------------------
// DB health watchdog.
//
// Every 5 minutes:
//   1. Flags long-running / stuck queries (older than DB_HEALTH_SLOW_MS,
//      default 60s) via pg_stat_activity.
//   2. Detects seq-scan drift on hot tables (receipts, fro_assignments,
//      fro_donor_logs, bank_audit_entries) — the "missing index" canary that
//      caused the CPU incident (agent_name ILIKE '%..%' seq scanning 100k+
//      rows). Non-zero seq_scan + zero/low idx_scan on a hot table is the
//      classic is-an-index-missing signal.
//
// Findings are logged. If DB_HEALTH_WEBHOOK is set, a JSON report is POSTed
// there with a `level` field so you can route it through Slack/Discord style
// inbound hooks.
// ---------------------------------------------------------------------------

const SLOW_MS = Number(process.env.DB_HEALTH_SLOW_MS || 60000);
const WEBHOOK = process.env.DB_HEALTH_WEBHOOK || '';

const HOT_TABLES = ['receipts', 'fro_assignments', 'fro_donor_logs', 'bank_audit_entries'];

export async function runDbHealthCheck() {
  const findings = [];

  const longRunning = await db._pool.query(`
    SELECT pid, usename, state, wait_event_type, wait_event,
           round(extract(epoch FROM (now() - query_start)))::int AS age_s,
           left(query, 300) AS query
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND state = 'active'
      AND query_start < now() - make_interval(secs => $1)
    ORDER BY query_start
  `, [SLOW_MS / 1000]);
  for (const r of longRunning.rows) {
    findings.push({
      level: 'warn',
      kind: 'slow-query',
      detail: `pid=${r.pid} ${r.usename} age=${r.age_s}s wait=${r.wait_event_type}/${r.wait_event}`,
      query: r.query,
    });
  }

  const tab = await db._pool.query(`
    SELECT relname, seq_scan, seq_tup_read,
           coalesce(idx_scan, 0) AS idx_scan
    FROM pg_stat_user_tables
    WHERE relname = ANY($1)
    ORDER BY seq_tup_read DESC
  `, [HOT_TABLES]);
  for (const r of tab.rows) {
    // A hot table showing unchanged-but-nonzero seq scanning with no index
    // usage is the missing-index signature. (idx_scan == 0 is a strong signal;
    // seq_tup_read growing is what makes it costly.)
    if (r.seq_scan > 1000 && r.seq_tup_read > 100000 && r.idx_scan === 0) {
      findings.push({
        level: 'error',
        kind: 'seq-scan-drift',
        detail: `${r.relname}: ${r.seq_scan} seq scans reading ${r.seq_tup_read} rows, ${r.idx_scan} index scans`,
      });
    }
  }

  if (findings.length === 0) {
    console.log('[db-health] all good');
    return { ok: true, findings: [] };
  }

  for (const f of findings) {
    const line = `[db-health] ${f.level.toUpperCase()} ${f.kind}: ${f.detail}`;
    if (f.level === 'error') console.error(line);
    else console.warn(line);
    if (f.query) console.warn(`   ${f.query}`);
  }

  if (WEBHOOK) {
    const body = JSON.stringify({
      ts: new Date().toISOString(),
      level: findings.some((f) => f.level === 'error') ? 'error' : 'warn',
      findings,
    });
    try {
      const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      console.log(`[db-health] webhook sent: ${res.status}`);
    } catch (e) {
      console.error('[db-health] webhook failed:', e.message);
    }
  }

  return { ok: false, findings };
}

let watchdogRunning = false;

export function startDbHealthWatchdog() {
  if (watchdogRunning) return;
  watchdogRunning = true;
  cron.schedule('*/5 * * * *', () => {
    runDbHealthCheck().catch((e) => console.error('[db-health] check error:', e.message));
  });
  console.log('Scheduled: DB health check every 5 minutes');
}

if (!process.env.VERCEL) {
  startDbHealthWatchdog();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runDbHealthCheck();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
