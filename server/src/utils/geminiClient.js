// ─────────────────────────────────────────────────────────────────────────────
// Shared Gemini REST helper (text → JSON).
//
// Deliberately self-contained and side-effect free: it only reads
// process.env.GEMINI_API_KEY / GEMINI_MODEL and never logs, returns or echoes
// the key. The API key stays server-side — nothing in this module is exposed to
// the Vite/React client, and callers must never forward the key in a response.
//
// The transport, model-rotation chain and retry policy mirror the working
// implementation in utils/aadhaarPhotoOcr.js:
//   • Free API keys only authenticate through the /v1beta `?key=` query endpoint.
//   • A model reported as retired/removed is skipped in favour of the next one.
//   • 503/429 (high demand / quota) retries the same model with a short backoff
//     before rotating.
//   • Any other HTTP status fails loudly so the caller can surface `detail`.
//
// Deliberate limit of this module: it produces *ideas only*. It is never asked
// for calendar dates — observance/festival dates come from utils/observances.js,
// which is fully deterministic.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];

/**
 * The rotation chain is resolved on CALL, not at module-evaluation time.
 *
 * WHY: this module is imported through utils/index-free ESM static imports, so it
 * is evaluated before index.js runs `dotenv.config()` (index.js calls dotenv at
 * line 109, but `import eventHeadRoutes` is hoisted to line 55). A module-level
 * constant therefore captured process.env.GEMINI_MODEL while it was still unset
 * and silently fell back to DEFAULT_MODELS. It only ever worked because
 * config/db.js happens to dotenv-load backend/.env at line 10 and is imported at
 * line 8 — an import-order coincidence, not a guarantee. Resolving lazily makes
 * GEMINI_MODEL authoritative regardless of which module loads first.
 */
const geminiModelChain = () => {
  const chain = [];
  if (process.env.GEMINI_MODEL) chain.push(process.env.GEMINI_MODEL);
  for (const m of DEFAULT_MODELS) if (!chain.includes(m)) chain.push(m);
  return chain;
};

export const geminiModelName = () => geminiModelChain()[0];
export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip ```json fences and any leading/trailing prose around the JSON body. */
export function parseJsonLoose(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: the first balanced-looking object/array in the body.
    const firstObj = cleaned.indexOf('{');
    const firstArr = cleaned.indexOf('[');
    let start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    if (start === -1) return null;
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    const end = cleaned.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Call Gemini with a text-only prompt and get JSON back.
 *
 * @param {string} prompt        Full instruction text (include the JSON shape).
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.4]
 * @param {number} [opts.maxOutputTokens=2048]
 * @returns {Promise<{value: any, model: string}>} the parsed JSON value and the model
 *                          that actually produced it (which may be a fallback after
 *                          rotation), or `{value: null, model}` when the model
 *                          returned an empty/unparseable body.
 * @throws  {Error} when GEMINI_API_KEY is missing or every model attempt failed.
 *                    The message never contains the key.
 */
export async function generateGeminiJson(prompt, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server');
  const text = String(prompt || '').trim();
  if (!text) throw new Error('gemini prompt is empty');

  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.4;
  const maxOutputTokens = typeof opts.maxOutputTokens === 'number' ? opts.maxOutputTokens : 2048;

  let lastError = null;
  for (const model of geminiModelChain()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        const endpoint =
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature,
              maxOutputTokens,
            },
          }),
        });
      } catch (e) {
        lastError = e;
        break; // network failure — try the next model
      }

      if (res.ok) {
        const json = await res.json();
        const body = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
        if (!body) return { value: null, model };
        return { value: parseJsonLoose(body), model };
      }

      const bodyText = await res.text();
      // Sanitise before surfacing: never echo the request URL (it carries the key).
      const msg = `Gemini HTTP ${res.status}: ${String(bodyText).slice(0, 300)}`;
      if (/no longer available|does not exist/i.test(msg)) {
        lastError = new Error(msg);
        break; // model retired — try the next model
      }
      // The whole key is rejected, so every remaining model would fail the same
      // way. Fail fast instead of repeating a doomed call for each of them.
      if (res.status === 401 || res.status === 403) throw new Error(msg);
      if (res.status === 503 || res.status === 429) {
        if (attempt < 2) {
          await sleep(600 * (attempt + 1));
          continue; // transient overload — retry the same model
        }
        lastError = new Error(msg);
        break; // still overloaded — try the next model
      }
      throw new Error(msg);
    }
  }
  throw lastError ?? new Error('no Gemini model available');
}
