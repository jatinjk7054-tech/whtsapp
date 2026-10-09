#!/usr/bin/env node
/**
 * Community chat layout contract guard.
 *
 * The bug this catches shipped once already. chat.css carried a
 * "mobile single-pane toggle" rule at the TOP LEVEL:
 *
 *   .chat-workspace[data-view='list'] .chat-thread,
 *   .chat-workspace[data-view='thread'] .chat-rail { display: none; }
 *
 * The comment above it even said "mobile single-pane toggle", and an identical
 * copy correctly sat inside `@media (max-width: 767px)`. The top-level copy
 * survived a copy/paste out of the media query, so on every desktop width the
 * inactive pane was hidden unconditionally: the rail and the thread could never
 * both be visible, and the 3-pane layout collapsed to one pane on desktop.
 *
 * Checking for the rule's mere presence is useless here - the correct copy
 * looks identical to the broken one. The only meaningful distinction is
 * whether the rule is nested in a media query, so this parser records the
 * enclosing at-rule conditions for every rule it sees.
 *
 * SCOPE: the community layout contract only (responsive pane switching, the
 * rail/thread grid, and the floating circle's stacking constraints). Not a
 * general CSS linter.
 *
 * Run: node backend/scripts/check-chat-layout.mjs [path-to-css]
 *
 * Accepts either the source stylesheet or a built bundle (dist/assets/*.css);
 * both are asserted with the same rules.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cssPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve('client/src/components/chat/chat.css')

// Strip comments before parsing. A comment that quotes a rule verbatim would
// otherwise inject a brace pair and desync the depth walk, silently skipping
// real rules.
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Flatten every style rule with the at-rule conditions it sits inside.
 * `conditions` is empty for a top-level rule, which is the entire point.
 *
 * Known limitation, shared with check-panel-scroll.mjs: a brace inside a CSS
 * string literal would desync the depth walk. No such literal exists here.
 */
function parseRules(source, conditions = []) {
  const out = []
  let buf = ''
  let i = 0
  while (i < source.length) {
    if (source[i] === '{') {
      const head = buf.trim()
      buf = ''
      let depth = 1
      let j = i + 1
      while (j < source.length && depth > 0) {
        if (source[j] === '{') depth++
        else if (source[j] === '}') depth--
        j++
      }
      const body = source.slice(i + 1, j - 1)
      if (head.startsWith('@')) out.push(...parseRules(body, [...conditions, head]))
      else if (head) out.push({ selector: head, body, conditions })
      i = j
      continue
    }
    buf += source[i]
    i++
  }
  return out
}

const rules = parseRules(css)
const failures = []
const notes = []

/** Rules in this rule's selector list mention `needle`. */
function mentions(rule, needle) {
  return rule.selector.split(',').some((s) => s.includes(needle))
}

// The attribute value is quote-optional so this also runs against the minified
// bundle, where the minifier rewrites `[data-view='list']` as `[data-view=list]`
// and `@media (max-width: 767px)` as `@media(max-width:767px)`. Being able to
// point this at dist/assets/*.css is the point: it then asserts on the CSS that
// actually ships rather than on the source someone intended.
const LIST_PANE = /data-view=['"]?list['"]?\]/
const THREAD_PANE = /data-view=['"]?thread['"]?\]/

const isPaneToggle = (r) =>
  (LIST_PANE.test(r.selector) && r.selector.includes('.chat-thread')) ||
  (THREAD_PANE.test(r.selector) && r.selector.includes('.chat-rail'))

const hides = (r) => /(^|[\s;{])display\s*:\s*none/.test(r.body)

const toggles = rules.filter((r) => isPaneToggle(r) && hides(r))
const topLevel = toggles.filter((r) => r.conditions.length === 0)
const inQuery = toggles.filter((r) => r.conditions.length > 0)

if (!toggles.length) {
  failures.push(
    'no single-pane toggle rule found at all\n' +
      '    expected `.chat-workspace[data-view=\'list\'] .chat-thread, ... { display: none }`\n' +
      '    inside `@media (max-width: 767px)`. Without it, mobile shows the rail and\n' +
      '    the thread at the same time and there is no way back to the list.'
  )
}

if (topLevel.length) {
  for (const r of topLevel) {
    failures.push(
      `single-pane toggle exists at TOP LEVEL: ${r.selector.replace(/\s+/g, ' ')} { ${r.body.trim()} }\n` +
        '    why:  outside a media query this hides the inactive pane on EVERY width,\n' +
        '          so the desktop 3-pane layout can never show the rail and the thread\n' +
        '          together. This is the exact regression that shipped.\n' +
        '    fix:  delete it here; the copy inside @media (max-width: 767px) is the\n' +
        '          only one that belongs.'
    )
  }
}

if (inQuery.length) {
  for (const r of inQuery) {
    const cond = r.conditions.join(' and ')
    if (!/max-width\s*:\s*767px/.test(cond)) {
      failures.push(
        `single-pane toggle is gated on an unexpected condition: ${cond}\n` +
          `    rule: ${r.selector.replace(/\s+/g, ' ')}\n` +
          '    why:  JS switches to single pane with `matchMedia(\'(max-width: 767px)\')`,\n' +
          '          so the CSS and the back button must agree on the same boundary.'
      )
    }
  }
  if (!failures.length) notes.push(`single-pane toggle: ok - scoped to ${inQuery[0].conditions.join(' and ')}`)
}

/** Grid definitions for .chat-workspace and the media query they live in. */
const gridRules = rules.filter((r) => mentions(r, '.chat-workspace') && /grid-template-columns|display\s*:\s*block/.test(r.body))
const ranges = gridRules
  .map((r) => {
    const cond = r.conditions.join(' and ') || 'top level'
    const cols = (r.body.match(/grid-template-columns\s*:\s*([^;}]+)/) || [, /display\s*:\s*block/.test(r.body) ? 'block' : ''])[1]
    return `${cond} -> ${String(cols).trim()}`
  })
  .sort()

if (gridRules.length < 2) {
  failures.push(
    'fewer than two .chat-workspace layout rules found\n' +
      `    found: ${ranges.join(' | ') || '(none)'}\n` +
      '    why:  the layout contract needs a multi-column grid at desktop widths and a\n' +
      '          single block pane below the mobile boundary.'
  )
} else {
  notes.push(`workspace layout:\n      ${ranges.join('\n      ')}`)
}

// The floating circle must stay under the drawer and overlay layers, or it
// covers an open drawer. Highest competing z-index in the app is 2601.
const fab = rules.find((r) => mentions(r, '.chat-fab') && r.conditions.length === 0 && /position\s*:\s*fixed/.test(r.body))
if (!fab) {
  failures.push('no top-level `.chat-fab` fixed-position rule found')
} else {
  const z = Number((fab.body.match(/(^|[\s;{])z-index\s*:\s*(\d+)/) || [, , 'NaN'])[2])
  if (!(z >= 0) || z >= 2600) {
    failures.push(
      `.chat-fab z-index is ${z}\n` +
        '    why:  panel drawers sit at 2600/2601 and accounts overlays at 9000. A circle\n' +
        '          at or above 2600 floats over an open drawer.'
    )
  } else {
    notes.push(`floating circle: ok - z-index ${z}, below the 2600 drawers`)
  }
  if (!/touch-action\s*:\s*none/.test(fab.body)) {
    failures.push(
      '`.chat-fab` is missing `touch-action: none`\n' +
        '    why:  without it a touch drag scrolls the page instead of moving the circle,\n' +
        '          which makes the drag feel broken on a phone.'
    )
  }
}

if (failures.length) {
  console.error('chat layout check FAILED\n')
  for (const f of failures) console.error(`  ${f}\n`)
  process.exit(1)
}

console.log('chat layout check: all passed')
for (const n of notes) console.log(`  ${n}`)
