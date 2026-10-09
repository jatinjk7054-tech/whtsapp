#!/usr/bin/env node
/**
 * Secret scanner — fails the build when a credential reaches a tracked file.
 *
 * Nothing in this repository would have caught the credentials that are
 * currently in git history (Meta Cloud API tokens, the RDS superuser password,
 * an AWS access key, the super-admin password). This is the control that
 * prevents a repeat. See docs/security/SECURITY.md P0-D and SEC-REQ-40.
 *
 * Only TRACKED files are scanned, so it is safe to run in CI and it never
 * inspects node_modules or a local build.
 *
 *   node scripts/security-check.mjs            # scan tracked files
 *   node scripts/security-check.mjs --staged   # only what is about to be committed
 *
 * Exit 0 = clean. Exit 1 = findings (printed with file:line). Exit 2 = bad usage.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = resolve(fileURLToPath(import.meta.url)).replace(/\\/g, '/')

// ── Config ───────────────────────────────────────────────────────────────────

/** Never scanned: build output, dependencies, VCS. */
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.vercel)(\/|$)/

/**
 * Paths exempt from the generic rules because they are documentation fixtures or
 * test scaffolding. The DSN rule is marked `always` and still runs on them, so a
 * genuine database credential hidden in a fixture is still caught.
 */
const EXEMPT = [
  /^client\/src\/panels\/documentation\/data\//,
  /^backend\/scripts\/generate_sample\./,
  /(^|\/)__snapshots__\//,
  /\.test\.js$/,
  /\.test\.mjs$/,
  /\.spec\.js$/,
]

/** This file, and any copy of it. */
const IS_SCANNER = (p) => p.endsWith('security-check.mjs')

/** Source files, for rules that only make sense in code (not prose). */
const CODE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i

/**
 * Every rule. `id` is stable and safe to reference in issues.
 * `always`      — run even on EXEMPT paths.
 * `codeOnly`    — run only on source files, never on prose (.md).
 * `pii`         — PII shape, not a secret. Opt in with --pii, because these are
 *                  high-volume and drown the actionable signal.
 * `placeholderGroup` — which capture group to test for placeholderness.
 */
const RULES = [
  {
    id: 'SN-01',
    name: 'Postgres connection string with an inline password',
    // Requires a plausible host, so documentation examples are not flagged.
    // Password must be at least 6 characters: shorter values are DSN diagrams
    // (e.g. postgres://user:pw@host) rather than real credentials.
    re: /postgres(?:ql)?:\/\/([A-Za-z0-9_.-]+):([^\s@'"]{6,})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    group: 2,
    always: true,
  },
  {
    id: 'SN-02',
    name: 'Meta WhatsApp Cloud API access token',
    // Real permanent tokens are 190+ chars and start with EAA followed by a
    // variety of characters (EAAG, EAAJ, EAAP, ...), not just EAAG.
    re: /\bEAA[A-Za-z0-9]{150,}/g,
    group: 0,
  },
  {
    id: 'SN-03',
    name: 'AWS access key ID',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    group: 0,
  },
  {
    id: 'SN-04',
    name: 'GitHub token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    group: 0,
  },
  {
    id: 'SN-05',
    name: 'Live payment / AI provider key',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bAIza[A-Za-z0-9_-]{30,}\b/g,
    group: 0,
  },
  {
    id: 'SN-06',
    name: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    group: 0,
  },
  {
    id: 'SN-07',
    name: 'JSON Web Token (signed, not a decoded sample)',
    // Requires three base64url segments and a signature-shaped third segment.
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
    group: 0,
  },
  {
    id: 'SN-08',
    name: 'A secret read from a VITE_ environment variable',
    // Vite inlines VITE_* into the public browser bundle (SEC-REQ-36).
    re: /import\.meta\.env\.(VITE_[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|KEY|TOKEN|CREDENTIAL)[A-Z0-9_]*)/g,
    group: 0,
    codeOnly: true,
  },
  {
    id: 'SN-09',
    name: 'Hardcoded credential in source',
    re: /\b(?:password|passwd|secret|api_?key|auth_?token|access_?key)\b\s*[:=]\s*['"]([^'"\s${}]{6,})['"]/gi,
    group: 1,
  },
  {
    id: 'SN-10',
    name: 'Indian PAN number in source',
    re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    group: 0,
    pii: true,
  },
  {
    id: 'SN-11',
    name: '12-digit Aadhaar-shaped number',
    re: /\b[2-9]\d{3}[ \-]?\d{4}[ \-]?\d{4}\b/g,
    group: 0,
    pii: true,
  },
]

/** Values that are documentation, not credentials. */
const PLACEHOLDER =
  /^(?:\$|\{|<|>|%|\[|x{3,}|\*{3,}|·|\u2022|\s)*$/i
/**
 * A value that is documentation rather than a credential.
 *
 * The trailing separator group is load-bearing. Without it the alternatives
 * `a` and `an` match any value *beginning* with that letter, and because the
 * pattern is case-insensitive that silently skipped every credential starting
 * with `a`/`A` — including AWS keys (AKIA...) and Meta tokens (EAAG...). Always
 * require a word boundary after the placeholder word.
 */
const PLACEHOLDER_WORDS =
  /^(?:your|my|the|a|an|example|sample|placeholder|dummy|fake|test|changeme|change[-_]?me|replace(?:[-_]?me)?|todo|tbd|none|null|nil|undefined|redacted|password|secret|key|token|value|insert|enter|default|some|any|foo|bar|baz|admin|user|localhost|127\.0\.0\.1|abc123|x{3,})(?:$|[-_ .,/:@])/i
const PLACEHOLDER_INLINE =
  /(?:your[_-]|example|sample|placeholder|changeme|change[-_]?me|replace[-_]?me|redacted|dummy|fake|wrong|intentional|on-purpose|do-not-use|\bxxx|<[^>]+>|\$\{|\{\{|\.\.\.|admin@example|example\.com|localhost|127\.0\.0\.1|\*\*\*)/i

/** Specific, known-safe literals. */
const ALLOW_EXACT = new Set([
  'Admin123!', // documented in history, no longer used — see SECURITY.md P0-D
  '123456', // SEC-018: the pre-filled admin default, a finding not a secret
  'your-jwt-secret',
  'your-access-token',
  'your-master-password',
  'your-webhook-verify-token',
  'your-waba-id',
  'your-phone-number-id',
  'your-head-access-key',
  'your-head-secret-key',
  'your-upstream-access-key',
  'your-upstream-secret-key',
  'change-me-strong-device-secret',
  'your-break-glass-admin-key',
  'replace-with-a-long-random-password',
  'test-secret-123',
  'wrong password',
  'wrongpassword',
  'not-a-real-password',
])

/** Extension allow-list. Binary and lock files are not text-scanned. */
const TEXT_EXT =
  /\.(?:js|jsx|mjs|cjs|ts|tsx|json|jsonc|yml|yaml|toml|conf|ini|env|example|txt|md|html|htm|xml|css|scss|sql|sh|ps1|bat|cmd|gradle|properties|plist|dart|kt|swift|rb|py|php|go|rs|java|cs|tf|tfvars|dockerfile)$/i
const TEXT_NAME = /^(?:Dockerfile|Makefile|\.env|\.env\.[A-Za-z]+|\.npmrc|\.envrc)$/i

/**
 * Files larger than this are skipped. Handwritten source is never this big, so
 * a hit means a generated artefact — the committed donor datasets under
 * backend/scripts/output/ are ~55 MB and ~48 MB. They are a data-protection
 * finding in their own right (SECURITY.md P3-A) and are handled by purging them
 * from history, not by scanning them here.
 */
const MAX_BYTES = 2 * 1024 * 1024

/** Reported so the skip is visible rather than silent. */
let skippedLarge = 0

// ── Helpers ──────────────────────────────────────────────────────────────────

function repoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return process.cwd()
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * NUL-separated file list. `git ls-files` quotes paths containing spaces
 * ("others/imp files/..."), which would make them unreadable and silently
 * skipped — exactly the directory holding the worst leaks in this repository.
 */
function trackedFiles(cwd) {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.split('\u0000').filter(Boolean)
}

function stagedFiles(cwd) {
  const raw = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.split('\u0000').filter(Boolean)
}

function isTextCandidate(rel, abs) {
  if (SKIP_DIR.test(rel)) return false
  const base = rel.split('/').pop()
  if (TEXT_NAME.test(base)) return true
  if (!TEXT_EXT.test(base)) return false
  // package-lock.json and similar are machine-generated and enormous.
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(rel)) return false
  try {
    if (statSync(abs).size > MAX_BYTES) {
      skippedLarge += 1
      return false
    }
  } catch {
    return false
  }
  return true
}

/** Byte offset -> 1-based line number, via a precomputed newline index. */
function makeLineIndex(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

function isPlaceholder(value) {
  const v = String(value ?? '').trim()
  if (!v) return true
  if (ALLOW_EXACT.has(v)) return true
  if (PLACEHOLDER.test(v)) return true
  if (PLACEHOLDER_WORDS.test(v)) return true
  if (PLACEHOLDER_INLINE.test(v)) return true
  // A run of identical characters, or a single repeated token.
  if (/^(.)\1+$/.test(v)) return true
  return false
}

/** Redact for display — never echo a full credential to a log or a CI page. */
function redact(value) {
  const v = String(value ?? '')
  if (v.length <= 8) return '*'.repeat(v.length)
  return `${v.slice(0, 3)}${'*'.repeat(Math.min(v.length - 6, 24))}${v.slice(-3)}`
}

// ── Scan ─────────────────────────────────────────────────────────────────────

function scan() {
  const root = repoRoot()
  const stagedOnly = process.argv.includes('--staged')
  const includePii = process.argv.includes('--pii')

  const relPaths = (stagedOnly ? stagedFiles(root) : trackedFiles(root))
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((p) => !IS_SCANNER(p))

  const envExample = []
  const candidates = []
  for (const p of relPaths) {
    const abs = join(root, ...p.split('/'))
    if (p.endsWith('.env.example') || /(^|\/)\.env\.example$/.test(p)) envExample.push(p)
    else if (isTextCandidate(p, abs)) candidates.push(p)
  }

  const findings = []

  // Generic rules.
  for (const rel of candidates) {
    const abs = join(root, ...rel.split('/'))
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue

    const exempt = EXEMPT.some((rx) => rx.test(rel))
    const isCode = CODE_EXT.test(rel)
    const lineOf = makeLineIndex(text)
    const lines = text.split(/\r?\n/)

    for (const rule of RULES) {
      if (rule.pii && !includePii) continue
      if (exempt && !rule.always) continue
      if (rule.codeOnly && !isCode) continue
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(text)) !== null) {
        const value = m[rule.group] ?? m[0]
        if (isPlaceholder(value)) continue

        const lineNo = lineOf(m.index)
        const line = lines[lineNo - 1] ?? ''
        // Skip comment-only lines: prose describing a risk is not a leak.
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue
        // Already-redacted samples such as *** or ••••••
        if (isPlaceholder(m[rule.group] ?? m[0])) continue

        findings.push({
          rule: rule.id,
          name: rule.name,
          file: rel,
          line: lineNo,
          match: redact(value),
          exempt,
        })
        if (findings.length > 500) return { findings, scanned: candidates.length + envExample.length, truncated: true }
      }
    }
  }

  // .env.example gets its own strict rule: names and placeholders ONLY.
  for (const rel of envExample) {
    const abs = join(root, ...rel.split('/'))
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    const assign = /^\s*(?:export\s+)?([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(.*)$/
    lines.forEach((line, i) => {
      if (line.trim().startsWith('#')) return
      const m = assign.exec(line)
      if (!m) return
      const [, key, rawValue] = m
      // Strip a trailing inline comment.
      const value = rawValue.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
      if (!value) return
      if (isPlaceholder(value)) return
      findings.push({
        rule: 'SN-12',
        name: 'Real value in a tracked .env.example',
        file: rel,
        line: i + 1,
        match: `${key}=${redact(value)}`,
        exempt: false,
      })
    })
  }

  return { findings, scanned: candidates.length + envExample.length, truncated: false }
}

// ── Report ───────────────────────────────────────────────────────────────────

function main() {
  let result
  try {
    result = scan()
  } catch (err) {
    process.stderr.write(`security-check: could not list tracked files (${err.message})\n`)
    return 2
  }

  const { findings, scanned, truncated } = result

  if (findings.length === 0) {
    process.stdout.write(
      `security-check: OK — ${scanned} tracked text files scanned, no secrets found` +
        `${skippedLarge ? ` (${skippedLarge} oversized generated files skipped, see SECURITY.md P3-A)` : ''}\n`,
    )
    return 0
  }

  const byRule = new Map()
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, [])
    byRule.get(f.rule).push(f)
  }

  process.stderr.write('\nsecurity-check: FAILED — credentials in tracked files\n\n')
  for (const [rule, list] of [...byRule].sort()) {
    const { name } = RULES.find((r) => r.id === rule) ?? { name: 'Real value in a tracked .env.example' }
    process.stderr.write(`  ${rule}  ${name}  (${list.length})\n`)
    for (const f of list.slice(0, 20)) {
      process.stderr.write(`      ${f.file}:${f.line}  ${f.match}\n`)
    }
    if (list.length > 20) process.stderr.write(`      … and ${list.length - 20} more\n`)
    process.stderr.write('\n')
  }
  process.stderr.write(
    'A credential in a tracked file is PUBLIC and must be rotated, not just\n' +
      'deleted. Rotation order: docs/security/SECURITY.md §7. To suppress a false\n' +
      'positive, add the value to ALLOW_EXACT in scripts/security-check.mjs with a\n' +
      'comment explaining why it is not a secret.\n',
  )
  if (truncated) process.stderr.write('\n(truncated at 500 findings — fix these first, then re-run)\n')
  return 1
}

process.exit(main())
