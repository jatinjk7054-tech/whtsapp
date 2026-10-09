// ─────────────────────────────────────────────────────────────────────────────
// Provider layer for AI idea generation (text prompt -> JSON).
//
// WHY THIS EXISTS: the Event Head calendar/activity suggestions are the one AI
// feature in this codebase that cannot rely on a single provider. Google denied
// the Gemini API project behind GEMINI_API_KEY (every model returns
//   403 "Your project has been denied access. Please contact support."
// while GET /v1beta/models still returns 200, so the key is valid and only
// *generation* is blocked on Google's side). No code change lifts that.
//
// So suggestions go through an ordered chain: Gemini first, because that is the
// intended provider, and Groq second, because the same repo already depends on
// groq-sdk for spelling (suggestEventSpelling) and sector activity
// (suggestSectorActivities) suggestions and it is a working free tier. When the
// Google project is unblocked, Gemini answers again automatically — no code
// change, no redeploy.
//
// Groq model: GROQ_CALENDAR_MODEL, default 'qwen/qwen3.8-27b'. Deliberately NOT
// openai/gpt-oss-120b, which is available on this account: it is a reasoning
// model that spends max_tokens on a `reasoning` field before answering, so with
// a tight budget it returns HTTP 200 with empty content and finish_reason
// "length" — a silent failure. See the long note in config/groq.js.
//
// SAFETY: like utils/geminiClient.js this module never logs, returns or echoes a
// key, and the request URL (which carries it) is never included in an error.
//
// This module produces *ideas only*. It is never asked for dates — festival and
// observance dates come from utils/observances.js, which is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

import groq from '../config/groq.js';
import { generateGeminiJson, geminiConfigured, geminiModelName, parseJsonLoose } from './geminiClient.js';

/* The Groq model for THIS feature, deliberately not GROQ_SUGGESTION_MODEL.
 *
 * GROQ_CHAT_MODEL is a general-purpose default that many other features share,
 * and on this account it currently resolves to openai/gpt-oss-120b. That model is
 * a *reasoning* model: it spends max_tokens on a `reasoning` field before it
 * answers, so a caller with a tight budget gets HTTP 200, empty content and
 * finish_reason "length" — the response is then silently discarded. The full
 * measurement is recorded in config/groq.js; do not "upgrade" this to
 * gpt-oss without raising every ceiling here and handling the reasoning field.
 *
 * qwen/qwen3.8-27b has no reasoning channel at all, which is why config/groq.js
 * picked it. It is verified working for this prompt shape. Overridable via
 * GROQ_CALENDAR_MODEL so a future deprecation is fixed in the environment first
 * rather than in a code change. */
const GROQ_SUGGESTION_MODEL = process.env.GROQ_CALENDAR_MODEL || 'qwen/qwen3.8-27b';

/* Hard ceiling on output tokens for a single Groq call.
 *
 * MEASURED, not guessed: the free tier enforces 1000 output tokens per minute
 * (OTPM) and refuses up front with
 *   429 rate_limit_exceeded "Request too large ... Limit 1000, Requested 1852"
 * when the request's expected output would exceed the remaining budget. So the
 * request has to be sized UNDER that ceiling, or it is rejected outright rather
 * than truncated. Callers ask for 10 rich suggestions, which is ~1650 tokens at
 * full field length — it does not fit, and at a 1000 cap the response truncates
 * at 6 items mid-JSON.
 *
 * That is why the prompt asks for COMPACT values under short keys: the JSON key
 * names alone cost ~45 tokens per suggestion, so 10 items cannot be afforded with
 * verbose keys. cleanSuggestion() already accepts the short aliases.
 *
 * Overridable via GROQ_CALENDAR_MAX_TOKENS for a paid tier that allows more. */
const GROQ_MAX_TOKENS = Number(process.env.GROQ_CALENDAR_MAX_TOKENS) > 0
  ? Number(process.env.GROQ_CALENDAR_MAX_TOKENS)
  : 950;

export const groqConfigured = () => Boolean(process.env.GROQ_API_KEY);

/** True when at least one provider could answer. */
export const aiSuggestionsConfigured = () => geminiConfigured() || groqConfigured();

/** Ordered provider chain; a provider with no key configured is skipped. */
const providerChain = () => {
  const chain = [];
  if (geminiConfigured()) chain.push('gemini');
  if (groqConfigured()) chain.push('groq');
  return chain;
};

export const activeProviders = () => providerChain().join(',') || 'none';

/** One-line, key-free boot/health report. Safe to log. */
export const aiSuggestionsStartupReport = () => {
  const parts = [];
  parts.push(
    geminiConfigured()
      ? `gemini=ready(model:${geminiModelName()})`
      : 'gemini=not-configured(GEMINI_API_KEY)'
  );
  parts.push(groqConfigured() ? `groq=ready(model:${GROQ_SUGGESTION_MODEL})` : 'groq=not-configured(GROQ_API_KEY)');
  const chain = providerChain();
  parts.push(
    chain.length
      ? `order=${chain.join('>')}${chain[0] !== 'gemini' ? ' (gemini unavailable, using fallback)' : ''}`
      : 'suggestions=disabled(no provider configured)'
  );
  return `AI suggestions: ${parts.join(' | ')}`;
};

/* ── provider adapters ─────────────────────────────────────────────────────
   Each returns { value, model }. `value` may be null when the model answered
   with something unusable — the chain then moves on, because a provider that
   produced no JSON has nothing to show.
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Recover the complete items from a JSON response that was cut off mid-array.
 *
 * WHY: when a provider hits its output-token ceiling it stops mid-string, leaving
 * invalid JSON. parseJsonLoose() then returns null and the entire response is
 * lost — 6 perfectly good suggestions thrown away because a 7th was incomplete.
 * That is the worst possible failure: HTTP 200, empty content to the user, and a
 * reason message that blames the wrong thing.
 *
 * So on `finish_reason: 'length'` we scan the array for individually balanced
 * `{...}` objects and JSON.parse each one on its own. Every object that closed
 * before the cut is a complete, valid suggestion and is kept; only the trailing
 * fragment is discarded.
 *
 * @returns {any[]|null} the recovered items, or null if none could be parsed.
 */
function salvageArrayItems(text, key) {
  const raw = String(text || '');
  const anchor = raw.indexOf(`"${key}"`);
  const arrStart = anchor === -1 ? raw.indexOf('[') : raw.indexOf('[', anchor);
  if (arrStart === -1) return null;

  const items = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrStart; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) items.push(parsed);
        } catch {
          /* unbalanced fragment — skip it */
        }
        start = -1;
      } else if (depth < 0) {
        return items.length ? items : null; // array closed cleanly enough
      }
    }
  }
  return items.length ? items : null;
}

const runGemini = async (prompt, opts) => {
  const r = await generateGeminiJson(prompt, opts);
  return { value: r.value ?? null, model: r.model, truncated: false };
};

const runGroq = async (prompt, opts) => {
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
  // Sized to the free tier's per-minute output budget, not to the caller's wish.
  const requested = typeof opts.maxOutputTokens === 'number' ? opts.maxOutputTokens : 2048;
  const maxTokens = Math.min(requested, GROQ_MAX_TOKENS);

  const completion = await groq.chat.completions.create({
    model: GROQ_SUGGESTION_MODEL,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You return strict JSON only. No markdown fences, no commentary, no prose outside the JSON object.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const choice = completion.choices?.[0];
  const text = (choice?.message?.content || '').trim();
  const model = GROQ_SUGGESTION_MODEL;
  if (!text) return { value: null, model, truncated: false };

  const parsed = parseJsonLoose(text);
  if (parsed) return { value: parsed, model, truncated: false };

  // Truncated mid-array: keep the items that closed before the cut.
  const salvaged = salvageArrayItems(text, 'suggestions');
  if (salvaged) {
    const e = new Error(`${model} hit its output-token ceiling (finish_reason=length); recovered the ${salvaged.length} complete suggestion(s) and dropped the partial remainder.`);
    e.partial = salvaged;
    e.truncated = true;
    throw e;
  }

  return { value: null, model, truncated: false };
};

const ADAPTERS = { gemini: runGemini, groq: runGroq };

/**
 * Run a prompt through the provider chain and return the first usable JSON value.
 *
 * @param {string} prompt        Full instruction text (include the JSON shape).
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.4]
 * @param {number} [opts.maxOutputTokens=2048]
 * @returns {Promise<{value:any, model:string, provider:string, attempts:Array}>}
 * @throws  {Error} when no provider is configured or every provider failed. The
 *          error carries `.attempts` (one entry per provider tried, each with a
 *          key-free `message`) so the caller can explain what happened instead of
 *          guessing from a concatenated string. The message never contains a key.
 */
export async function generateSuggestionJson(prompt, opts = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('suggestion prompt is empty');

  const chain = providerChain();
  if (!chain.length) {
    const e = new Error('no AI provider is configured on this server');
    e.attempts = [];
    throw e;
  }

  const attempts = [];
  for (const provider of chain) {
    try {
      const r = await ADAPTERS[provider](text, opts);
      if (r.value == null) {
        attempts.push({ provider, message: `${provider} returned no usable JSON` });
        continue;
      }
      return { value: r.value, model: r.model, provider, truncated: false, attempts };
    } catch (error) {
      // A provider that ran out of output tokens but still produced whole
      // suggestions is a partial SUCCESS, not a failure. Returning the recovered
      // items beats discarding good suggestions over one incomplete last item —
      // and beats falling through to a second provider, which would burn the same
      // exhausted per-minute budget anyway.
      if (error?.partial) {
        return {
          value: { suggestions: error.partial },
          model: error.model || null,
          provider,
          truncated: true,
          attempts,
        };
      }
      attempts.push({ provider, message: String(error?.message || error) });
    }
  }

  const summary = attempts.map((a) => a.message).join(' | ');
  const e = new Error(summary || 'every AI provider failed');
  e.attempts = attempts;
  throw e;
}
