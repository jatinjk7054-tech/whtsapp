#!/usr/bin/env node
/**
 * Panel scroll regression guard.
 *
 * Context, because this bug shipped: commit 52d8600a gave `.panel-hr .app`
 * `height:100dvh; overflow:hidden` to fix unscrollable Community in the Super
 * Admin panel. That reasoning was verified for SA and then copied to HR,
 * recruiter and ngo-admin without checking whether those panels have the inner
 * scroller the fix depends on.
 *
 * They do not. Measured in this stylesheet:
 *
 *   .panel-sa .main          { flex:1; display:flex; flex-direction:column; overflow:hidden }
 *   .panel-sa .content-body  { flex:1; overflow-y:auto }
 *   .panel-hr .main          { flex:1; min-width:0 }              <- no scroller
 *   .panel-hr .content-body  { padding:20px 28px 60px }           <- padding only
 *
 * A fixed-height, overflow:hidden shell only works when something inside it
 * scrolls. Where nothing does, the shell clips every page taller than the
 * viewport and the overflow is unreachable - the panel looks unscrollable and
 * the scrollbar is simply gone. That is what happened to HR.
 *
 * SCOPE, deliberately narrow. This is not a general CSS linter and must not be
 * grown into one. `.panel-fro`, `.panel-accounts` and `.panel-event-head` also
 * set overflow:hidden on `.app` while having no general content-area scroller -
 * they bring their own per-page scrollers instead - so a rule of the form
 * "overflow:hidden requires overflow-y:auto somewhere" would fail on three
 * long-shipping panels and be wrong. This file therefore only asserts the
 * requirement for the three panels confirmed to scroll via the window. If one
 * of them is ever restructured to own a real inner scroller, delete it here.
 *
 * ROUTE-SCOPED SHELLS ARE ALLOWED, WITH AN OBLIGATION. Community chat needs a
 * bounded, internally scrolling region on these same panels, so
 * `.panel-hr.is-chat-route .app` (and its siblings) are accepted. The
 * qualifier is what makes that safe: it cannot reach the panel's other pages,
 * which keeps the window scroll they depend on. In exchange the same scope has
 * to turn `.content-body` into a box that grows and can shrink - `flex:1` plus
 * `min-height:0` - so the clipping has something scrolling behind it.
 *
 * Both halves are asserted. Dropping the qualifier fails as the 52d8600a
 * regression did; keeping the shell but removing the fill fails too, which is
 * the subtler half: `flex:1` without `min-height:0` leaves a flex item that
 * refuses to shrink below its content, and the parent's overflow:hidden clips
 * it anyway.
 *
 * Run: node backend/scripts/check-panel-scroll.mjs [path-to-css]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cssPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve('client/src/index.css')

// Comments are stripped before any parsing. This is not cosmetic: a comment
// that quotes a rule verbatim (`.panel-sa .app { display:flex; min-height:100vh; }`)
// puts a brace pair inside a comment, and a naive `{...}` scan then pairs those
// comment braces with real declarations and silently skips whole rules. That
// turned this check into a false negative - it reported "no .app rule" for
// every panel while reading the exact stylesheet that had the bug. Stripping
// first also stops comments that mention overflow-y:auto from satisfying
// hasInnerScroller().
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Panels whose content region scrolls the WINDOW, not a nested box. */
const WINDOW_SCROLLERS = ['panel-hr', 'panel-recruiter', 'panel-ngo-admin']

/**
 * Body text of every rule whose selector mentions `${panel} .${leaf}`.
 *
 * Qualifier classes between the panel and the leaf are captured rather than
 * ignored. `.panel-hr .app` and `.panel-hr.is-chat-route .app` are different
 * rules with opposite consequences, and treating them the same is what let the
 * 52d8600a regression pass this check.
 */
function appRuleBodies(panel, leaf = 'app') {
  const bodies = []
  // Match `... <panel>[.<qualifier>]* .<leaf> ... { ... }`, including inside
  // selector lists, so a shared rule like `.panel-accounts .app, .panel-fro .app`
  // is seen for every panel it covers.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  const leafRe = new RegExp(`\\.${panel}(?:\\.([\\w-]+))?\\s+\\.${leaf}\\s*$`)
  let m
  while ((m = ruleRe.exec(css)) !== null) {
    const [, selector, body] = m
    const selectors = selector.split(',').map((s) => s.trim())
    const qualifiers = []
    let matched = false
    for (const s of selectors) {
      const hit = leafRe.exec(s)
      if (!hit) continue
      matched = true
      if (hit[1]) qualifiers.push(hit[1])
    }
    if (!matched) continue
    bodies.push({ selector: selectors.join(', '), body, qualifiers })
  }
  return bodies
}

/** True if the body sets overflow:hidden (clipping). */
function clips(body) {
  return /(^|[\s;{])overflow\s*:\s*hidden/.test(body)
}

/**
 * A definite height, as opposed to min-height (which still grows with content)
 * or `height:auto` (which explicitly does not constrain anything).
 */
function hasDefiniteHeight(body) {
  const stripped = body
    .replace(/min-height\s*:[^;}]*/g, '')
    .replace(/(^|[\s;{])height\s*:\s*auto\b/g, '$1height:auto-ignored')
  return /(^|[\s;{])height\s*:(?!auto-ignored)/.test(stripped)
}

/** Selectors under `panel` that declare overflow-y:auto, for review context. */
function innerScrollerSelectors(panel) {
  const re = new RegExp(`\\.${panel}\\s+(\\.[A-Za-z0-9_-]+)\\s*\\{[^}]*overflow-y\\s*:\\s*auto`, 'gs')
  const found = new Set()
  let m
  while ((m = re.exec(css)) !== null) found.add(m[1])
  return [...found]
}

/**
 * True if a body turns its box into a growing, shrinkable flex item.
 *
 * This is what makes a route-scoped clipping shell legitimate: the region is
 * bounded but no longer growing with its content, so a scrolling child can
 * take over. `flex:1` alone is not enough - without `min-height:0` a flex item
 * refuses to shrink below its content and the parent's `overflow:hidden`
 * quietly clips again.
 */
function fillsHeight(body) {
  const grows = /(^|[\s;{])flex\s*:\s*1/.test(body)
  const shrinkable = /(^|[\s;{])min-height\s*:\s*0/.test(body)
  return grows && shrinkable
}

const failures = []
const notes = []

/**
 * The chain that has to stay un-clipped. `.app` is the reported failure, but a
 * definite height on `.main` or a clipping `.content-body` produces the same
 * unreachable overflow one level in, so all three are checked.
 */
const CHAIN = ['app', 'main', 'content-body']

for (const panel of WINDOW_SCROLLERS) {
  const comps = innerScrollerSelectors(panel)
  let flagged = 0

  for (const leaf of CHAIN) {
    const rules = appRuleBodies(panel, leaf)
    if (!rules.length) continue

    for (const o of rules.filter((r) => clips(r.body) && hasDefiniteHeight(r.body))) {
      // A shell qualified by a route/state class is allowed, because it cannot
      // reach the panel's other pages. It is not allowed for free: something
      // inside has to become the scroller, or that route clips the same way
      // 52d8600a did.
      if (o.qualifiers.length) {
        const body = appRuleBodies(panel, 'content-body').find(
          (r) => r.qualifiers.some((q) => o.qualifiers.includes(q)) && fillsHeight(r.body)
        )
        if (body) {
          notes.push(
            `${panel}: .${leaf} fixed shell ok when ${o.qualifiers.map((q) => `.${q}`).join('')} ` +
              `- scoped, and .content-body fills in the same scope`
          )
          continue
        }
        failures.push(
          `${panel}: .${leaf} is a clipping fixed shell scoped to ` +
            `${o.qualifiers.map((q) => `.${q}`).join('')} but nothing scrolls inside\n` +
            `    rule: ${o.selector} { ${o.body.trim()} }\n` +
            `    why:  the scope keeps the panel's other pages safe, but this route then\n` +
            `          has the same unreachable-overflow bug unless the content region\n` +
            `          becomes a box that grows and scrolls.\n` +
            `    fix:  in the same scope give .content-body 'flex:1' plus 'min-height:0'\n` +
            `          (and a scroller, or overflow:hidden with a scrolling child).`
        )
        flagged++
        continue
      }

      flagged++
      failures.push(
        `${panel}: .${leaf} is a clipping fixed shell\n` +
          `    rule: ${o.selector} { ${o.body.trim()} }\n` +
          `    why:  ${panel} scrolls the WINDOW - its content region is not a nested\n` +
          `          scroller. A definite height plus overflow:hidden on the shell clips\n` +
          `          every page taller than the viewport, and the overflow cannot be\n` +
          `          reached: the panel looks unscrollable and has no scrollbar to drag.\n` +
          `          This is exactly what 52d8600a did to all three panels.\n` +
          `    fix:  min-height:100vh and no overflow on .${leaf} for the default\n` +
          `          routes. If ONE route genuinely needs an internal scroller, scope it\n` +
          `          with a class (e.g. .${panel}.is-chat-route) so the rest are untouched.` +
          (comps.length
            ? `\n    note: ${panel} does declare overflow-y:auto on ${comps.join(' ')} - those are\n` +
              `          sidebar/drawer/card components, not the content region. If a real\n` +
              `          content-region scroller has since been added, drop ${panel} from\n` +
              `          WINDOW_SCROLLERS above instead of allowing the clip.`
            : '')
      )
    }
  }

  if (!flagged) {
    const bodies = appRuleBodies(panel)
      .map((r) => r.body.trim())
      .join(' | ')
    notes.push(`${panel}: ok - window scrolls (${bodies})`)
  }
}

if (failures.length) {
  console.error('panel scroll check FAILED\n')
  for (const f of failures) console.error(`  ${f}\n`)
  process.exit(1)
}

console.log('panel scroll check: all passed')
for (const n of notes) console.log(`  ${n}`)
