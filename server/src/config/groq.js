import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * The chat model every Groq call in this service uses.
 *
 * WHY THIS IS ONE DEFINITION AND NOT A STRING IN EACH CALLER. The account had
 * llama-3.3-70b-versatile removed from it, so every call 404'd with
 * model_not_found - silently, once per call, with the response discarded. Four
 * separate files each hardcoded the name, so each had to be found and fixed
 * independently, and a future deprecation has to be found four times again.
 * One definition here means a rename is one edit.
 *
 * WHY NOT openai/gpt-oss-120b, WHICH IS ALSO AVAILABLE. It is a reasoning
 * model: it spends max_tokens on a `reasoning` field before it answers. Where
 * the caller budgets tightly - notificationScheduler at 80 tokens, emailImporter
 * at 200 - the reasoning consumes the whole allowance and the response comes
 * back with finish_reason "length" and content "" . Measured on 2026-09-29:
 *
 *   gpt-oss-120b  notificationScheduler  EMPTY  (reasoning ate 384 of 80... and truncated)
 *   gpt-oss-120b  emailImporter          EMPTY  (reasoning ate 791)
 *   gpt-oss-120b  quizController          OK    (300 tokens was enough)
 *   qwen3.8-27b   all three              OK    (no reasoning channel at all)
 *
 * That is a worse failure than the 404, because it returns HTTP 200: the HR
 * notification ships blank and the email importer's JSON.parse finds nothing.
 * Do not "upgrade" this to gpt-oss without raising every max_tokens ceiling
 * and handling the reasoning field.
 *
 * Also ruled out on 2026-09-29: allam-2-7b (answers the quiz in Arabic),
 * canopylabs/orpheus-* (rejected: requires terms acceptance).
 *
 * Override with GROQ_CHAT_MODEL without a deploy, which is how the next
 * deprecation gets fixed in the environment first.
 */
export const GROQ_CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ||
  process.env.GROQ_CONGRATS_MODEL ||
  process.env.GROQ_SPELLING_MODEL ||
  'qwen/qwen3.8-27b';

export default groq;
