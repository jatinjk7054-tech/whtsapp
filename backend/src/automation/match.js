/**
 * Module 9 — keyword matching. Pure functions only: no database and no network,
 * so the same code backs both the live webhook and the Admin "Test rule" button.
 * Every comparison is case-insensitive; a `whole_word` match uses Unicode-aware
 * boundaries so "gift" does not fire inside "gifting".
 */

export const MATCH_TYPES = ['contains', 'exact', 'starts_with', 'ends_with', 'whole_word'];

export const MATCH_TYPE_LABELS = {
  contains: 'Contains',
  exact: 'Exactly matches',
  starts_with: 'Starts with',
  ends_with: 'Ends with',
  whole_word: 'Contains whole word',
};

/** Escapes the regex metacharacters so a keyword is never treated as a pattern. */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeMatchType(matchType) {
  return MATCH_TYPES.includes(matchType) ? matchType : 'contains';
}

/**
 * True when `body` satisfies `keyword` under `matchType`.
 * An empty keyword or empty body never matches (avoids the "because the rule is
 * blank, every message matches" failure).
 */
export function matchesKeyword(body, keyword, matchType = 'contains') {
  const text = String(body ?? '').toLowerCase().trim();
  const needle = String(keyword ?? '').toLowerCase().trim();
  if (!needle || !text) return false;

  switch (normalizeMatchType(matchType)) {
    case 'exact':
      return text === needle;
    case 'starts_with':
      return text.startsWith(needle);
    case 'ends_with':
      return text.endsWith(needle);
    case 'whole_word': {
      // \p{L}\p{N} keep accented letters and digits inside words; an underscore
      // is a word character too, matching JS regex \w semantics.
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}_])${escapeRegex(needle)}([^\\p{L}\\p{N}_]|$)`,
        'u'
      );
      return pattern.test(text);
    }
    case 'contains':
    default:
      return text.includes(needle);
  }
}

/**
 * Rules must already be ordered by priority (highest first) then id, so the
 * first match is the winner. Returns null when nothing matches.
 */
export function findMatchingRule(body, rules = []) {
  for (const rule of rules) {
    if (matchesKeyword(body, rule.keyword, rule.match_type)) return rule;
  }
  return null;
}
