/**
 * READ-ONLY report: worker-days whose idle looks like the work-as
 * mis-attribution, for human review before anything is repaired.
 *
 * This script executes SELECT statements ONLY. It opens a read-only transaction
 * and asserts it, so Postgres itself rejects any write that slips in. It changes
 * no data — it is the review artefact for decision A, and nothing is repaired
 * until someone reads this output and asks for it.
 *
 * Run it from the backend directory; it reads backend/.env itself, exactly as the
 * server does, so it always reports on the same database the live app is using:
 *
 *     node scripts/report-workas-idle.mjs                     # last 60 days
 *     node scripts/report-workas-idle.mjs 2026-09-01 2026-09-30
 *
 * Output is a summary on stdout plus a full CSV, because the row count runs to
 * hundreds and scrolling a console is not how anybody audits this.
 *
 * The three categories are SIGNALS, not verdicts. Each can be produced by a
 * genuine day of slacking as well as by the cover bug, which is the point: the
 * repair decision is a human one, row by row.
 *
 *   [1] over_day     idle larger than the whole working day. Nobody sits a desk
 *                    for more than their own shift, so this is a direct read-out
 *                    of a disposition deadline backdated against somebody who was
 *                    not there. Strongest signal.
 *   [2] covered_day  idle banked on a day the person was being covered. Legitimate
 *                    if they were also at their own desk — that is the chain case,
 *                    Priya covering Riya while the real Riya works Meera — so this
 *                    needs a human eye rather than a blind repair.
 *   [3] silent_day   idle banked on a day with no calls and no talk time at all.
 *                    Usually a cover they were never present for.
 *
 * Only covers with a work_as_sessions row are visible to category [2]; anything
 * older than that table is invisible to it and can only surface via [1] or [3].
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '..', '.env') });

const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL / TEST_DATABASE_URL is not set (and backend/.env was not readable).');
  process.exit(1);
}

const [fromArg, toArg] = process.argv.slice(2);
const to = toArg || new Date().toISOString().slice(0, 10);
const from = fromArg || new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

// Mirror the app's own connection settings from config/db.js. RDS requires TLS
// and pg_hba refuses a plain ("no encryption") connection from the app subnet, so
// a raw pg.Client with just the URL fails where the pool succeeds. Keep the two
// in step: DATABASE_SSL=false and PGSSLMODE=disable both mean "plain", anything
// else means TLS with a self-tolerant verifier, exactly as the pool does.
const ssl = (process.env.DATABASE_SSL === 'false' || process.env.PGSSLMODE === 'disable')
  ? false
  : { rejectUnauthorized: false };

const client = new pg.Client({ connectionString: url, ssl });
await client.connect();

// Belt and braces: a read-only transaction makes any accidental write fail loudly
// rather than silently mutating production data.
await client.query('BEGIN READ ONLY');

const num = (v) => Number(v || 0);
const hms = (secs) => {
  const s = Math.max(0, Math.round(num(secs)));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
// pg hands back a Date for date-ish columns, so normalise before printing or the
// table fills with "Wed Sep 23 2026 00:00:00 GMT+0000 (Coordinated Universal
// Time)" instead of a date.
const isoDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const pad = (v, n) => String(v ?? '').padEnd(n);

const findings = [];
  const add = (category, r) => {
    findings.push({
      category,
      date: isoDate(r.stat_date),
      worker_id: String(r.worker_id ?? ''),
      worker: String(r.name || r.worker_id || ''),
      idle_seconds: num(r.idle_seconds),
      idle: hms(r.idle_seconds),
      calls: num(r.calls),
      talk_seconds: num(r.talk_seconds),
      talk: hms(r.talk_seconds),
      covered_by: r.operator_name || '',
      operator_calls: num(r.operator_calls),
    });
  };

try {
  console.log(`\nWork-as idle review  —  ${from} to ${to}`);
  console.log('READ ONLY. No data is modified by this script.\n');

  // ── [1] Idle larger than the working day ──────────────────────────────────
  // The widest plausible day, from the configured office hours. Anything beyond
  // it is not a shift somebody sat through. Read from fro_daily_stats, which is
  // the table the monthly salary figures sum.
  const { rows: officeEnd } = await client.query(
    `SELECT value FROM settings WHERE key = 'office_end_time'`
  );
  const endHour = Number(String(officeEnd?.[0]?.value || '19:00').split(':')[0]) || 19;
  const openHour = 9;
  const maxPlausible = (endHour - openHour) * 3600;

  const { rows: overDay } = await client.query(
    `SELECT d.worker_id, w.name, d.stat_date, d.idle_seconds, d.calls, d.talk_seconds
       FROM fro_daily_stats d
       LEFT JOIN workers w ON w.id::text = d.worker_id::text
      WHERE d.stat_date BETWEEN $1 AND $2::date
        AND COALESCE(d.idle_seconds, 0) > $3
      ORDER BY d.idle_seconds DESC`,
    [from, to, maxPlausible]
  );
  overDay.forEach(r => add('over_day', r));

  // ── [2] Idle banked on a day the person was covered ───────────────────────
  // A cover existed on that date AND the covered FRO banked idle. Legitimate if
  // they were also working their own account, so this is a shortlist, not a fault.
  const { rows: coveredIdle } = await client.query(
    `WITH covers AS (
       SELECT DISTINCT s.operator_user_id, s.operator_name,
              s.target_fro_worker_id, DATE(s.created_at) AS d
         FROM work_as_sessions s
        WHERE s.created_at::date BETWEEN $1 AND $2::date
     )
     -- Aggregated per (covered FRO, day) for the same reason as category [4]:
     -- several operators on one day is normal and must not duplicate the row or
     -- the idle hours attached to it.
     SELECT c.target_fro_worker_id AS worker_id,
            w.name,
            c.d AS stat_date,
            COALESCE(ds.idle_seconds, 0) AS idle_seconds,
            COALESCE(ds.calls, 0) AS calls,
            COALESCE(ds.talk_seconds, 0) AS talk_seconds,
            STRING_AGG(DISTINCT COALESCE(c.operator_name, c.operator_user_id::text), ' + ') AS operator_name
       FROM covers c
       JOIN workers w ON w.id::text = c.target_fro_worker_id::text
       LEFT JOIN fro_daily_stats ds
              ON ds.worker_id::text = c.target_fro_worker_id::text
             AND ds.stat_date = c.d
      WHERE COALESCE(ds.idle_seconds, 0) > 0
      GROUP BY c.target_fro_worker_id, w.name, c.d,
               ds.idle_seconds, ds.calls, ds.talk_seconds
      ORDER BY ds.idle_seconds DESC`,
    [from, to]
  );
  coveredIdle.forEach(r => add('covered_day', r));

  // ── [3] Idle on a day with no calls and no talk time ──────────────────────
  const { rows: silentDay } = await client.query(
    `SELECT d.worker_id, w.name, d.stat_date, d.idle_seconds, d.calls, d.talk_seconds
       FROM fro_daily_stats d
       LEFT JOIN workers w ON w.id::text = d.worker_id::text
      WHERE d.stat_date BETWEEN $1 AND $2::date
        AND COALESCE(d.idle_seconds, 0) > 0
        AND COALESCE(d.calls, 0) = 0
        AND COALESCE(d.talk_seconds, 0) = 0
      ORDER BY d.idle_seconds DESC`,
    [from, to]
  );
  silentDay.forEach(r => add('silent_day', r));

  // ── [4] The signature: covered FRO idle, operator took the calls ─────────
  // The strongest confirmation available, because it is a closed loop rather
  // than an anomaly. On this day:
  //   - the FRO was covered by somebody,
  //   - the FRO banked idle and recorded nothing at all, and
  //   - the covering operator recorded calls on the SAME day.
  //
  // Donor credit follows the person at the keyboard, so a working cover produces
  // calls on the operator and no calls on the covered FRO. Idle on the covered
  // FRO that same day is therefore not slacking — it is time attributed to
  // somebody who was working. Every row here is a mis-attribution rather than a
  // judgement call, which is what makes this the list to repair first.
  const { rows: phantom } = await client.query(
    `WITH covers AS (
       SELECT DISTINCT s.operator_user_id, s.operator_name,
              s.target_fro_worker_id, DATE(s.created_at) AS d
         FROM work_as_sessions s
        WHERE s.created_at::date BETWEEN $1 AND $2::date
     ),
     -- One row per (covered FRO, day), NOT per (operator, FRO, day).
     --
     -- Two operators covering the same FRO on the same day is normal, and keying
     -- the query by operator produced one row per operator while the display name
     -- came from a single lateral lookup — so the same worker-day was printed
     -- several times over and the idle hours were counted several times with it.
     -- The calls are summed across everyone who covered, because every one of
     -- those calls is work the FRO on the row is not credited with.
     covered AS (
       SELECT c.target_fro_worker_id AS worker_id,
              c.d AS stat_date,
              SUM((
                SELECT COUNT(*) FROM fro_donor_logs l
                 WHERE l.fro_worker_id::text = c.operator_user_id::text
                   AND l.created_at::date = c.d
              ))::int AS operator_calls,
              STRING_AGG(DISTINCT COALESCE(c.operator_name, c.operator_user_id::text), ' + ') AS operator_name
         FROM covers c
        GROUP BY c.target_fro_worker_id, c.d
     )
     SELECT cv.worker_id,
            w.name,
            cv.stat_date,
            d.idle_seconds,
            d.calls,
            d.talk_seconds,
            cv.operator_name,
            cv.operator_calls
       FROM covered cv
       JOIN workers w ON w.id::text = cv.worker_id::text
       JOIN fro_daily_stats d
         ON d.worker_id::text = cv.worker_id::text AND d.stat_date = cv.stat_date
      WHERE COALESCE(d.idle_seconds, 0) > 0
        AND COALESCE(d.calls, 0) = 0
        AND COALESCE(d.talk_seconds, 0) = 0
        AND cv.operator_calls > 0
      ORDER BY d.idle_seconds DESC`,
    [from, to]
  );
  phantom.forEach(r => add('phantom_covered', r));

  // ── Summary ───────────────────────────────────────────────────────────────
  const LABELS = {
    over_day: `idle longer than a ${openHour}:00-${String(endHour).padStart(2, '0')}:00 day`,
    covered_day: 'idle on a day the person was covered',
    silent_day: 'idle on a day with no calls and no talk time',
    phantom_covered: 'idle while covered, operator took the calls (confirmed)',
  };

  console.log('='.repeat(78));
  console.log('Summary');
  console.log('='.repeat(78));
  for (const [cat, rows] of Object.entries({
    over_day: overDay,
    covered_day: coveredIdle,
    silent_day: silentDay,
    phantom_covered: phantom,
  })) {
    const hours = rows.reduce((a, r) => a + num(r.idle_seconds), 0) / 3600;
    console.log(`  ${pad(LABELS[cat], 52)} ${pad(rows.length, 5)} rows ${pad(hours.toFixed(1) + ' h', 10)}`);
  }

  const keys = new Set(findings.map(f => `${f.worker_id}|${f.date}`));
  const totalIdleH = findings.reduce((a, f) => a + f.idle_seconds, 0) / 3600;
  const people = new Set(findings.map(f => f.worker_id)).size;
  console.log(`  ${pad('distinct worker-days flagged (any category)', 52)} ${keys.size}`);
  console.log(`  ${pad('distinct people involved', 52)} ${people}`);
  console.log(`  ${pad('idle across every finding (overlapping, not a total owed)', 52)} ${totalIdleH.toFixed(1)} h`);

  // The rows that need a decision first: [4] is a closed loop of evidence rather
  // than an anomaly, so it leads; [1] is the clearest raw anomaly after it.
  if (phantom.length > 0) {
    console.log(`\n${'='.repeat(78)}`);
    console.log('Category [4] — covered FRO idle while the operator took the calls (confirmed)');
    console.log(`${pad('WORKER', 26)}${pad('DATE', 12)}${pad('IDLE', 10)}${pad('OP CALLS', 9)}COVERED BY`);
    for (const f of findings.filter(f => f.category === 'phantom_covered').slice(0, 40)) {
      console.log(`  ${pad(f.worker.slice(0, 25), 26)}${pad(f.date, 12)}${pad(f.idle, 10)}${pad(f.operator_calls, 9)}${f.covered_by}`);
    }
    if (phantom.length > 40) console.log(`  ... and ${phantom.length - 40} more, all in the CSV`);
  }

  if (overDay.length > 0) {
    console.log(`\n${'='.repeat(78)}`);
    console.log('Category [1] — idle beyond a whole working day, worst first');
    console.log(`${pad('WORKER', 26)}${pad('DATE', 12)}${pad('IDLE', 10)}${pad('CALLS', 6)}TALK`);
    for (const f of findings.filter(f => f.category === 'over_day')) {
      console.log(`  ${pad(f.worker.slice(0, 25), 26)}${pad(f.date, 12)}${pad(f.idle, 10)}${pad(f.calls, 6)}${f.talk}`);
    }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  // The reviewable artefact. One row per finding, so a decision can be recorded
  // per line without re-running anything.
  const outDir = process.env.REPORT_OUT_DIR || resolve(here, '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  const csvPath = resolve(outDir, `workas-idle-review_${from}_to_${to}.csv`);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'category,date,worker,worker_id,idle_seconds,idle,calls,talk_seconds,talk,covered_by,operator_calls';
  const body = findings
    .slice()
    .sort((a, b) => b.idle_seconds - a.idle_seconds)
    .map(f => [f.category, f.date, f.worker, f.worker_id, f.idle_seconds, f.idle, f.calls, f.talk_seconds, f.talk, f.covered_by, f.operator_calls].map(esc).join(','));
  writeFileSync(csvPath, [header, ...body].join('\n') + '\n', 'utf8');

  console.log(`\nFull list (${findings.length} rows): ${csvPath}`);
  console.log('\nNothing was modified. Repair is a separate, explicit decision.');

  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nReport failed:', e?.message || String(e));
  process.exitCode = 1;
} finally {
  await client.end();
}
