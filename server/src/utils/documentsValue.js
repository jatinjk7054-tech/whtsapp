// Which documents a volunteer has handed over, stored in workers.documents_value
// (TEXT, migration 137) with the custom name for "Other" in workers.documents_other
// (migration 160). Mirrors client/src/lib/labels.js DOC_OPTIONS, which is what the
// HR Panel's "Documents Needed" checkboxes, the profile card and the
// volunteer-facing submitted form all render. The two lists have to stay
// identical or a value a volunteer is allowed to pick would be rejected on write.
//
// documents_value started life as a single value and became a JSON array string:
//   ["10th","Degree"]           multi-select, current format
//   "12th"                      legacy single value, still written by older clients
// So every reader has to go through parseDocumentsValue rather than reading the
// column directly, or the 30-odd existing rows would silently read as empty.

export const DOC_OPTIONS = [
  '10th',
  '12th',
  'Degree',
  'Voter ID',
  'Marriage Certificate',
  'Other',
];

// Named so the "Other" branch is never a magic string repeated across files.
export const OTHER_DOC = 'Other';

// Returns the value when it is one of the known options, otherwise null.
// An empty/whitespace-only value also normalises to null: that is the caller
// clearing the field, not a bad request, so callers must tell the two apart by
// testing the raw input (see updateMyProfile).
export const normalizeDocumentsValue = (value) => {
  const trimmed = String(value ?? '').trim();
  return DOC_OPTIONS.includes(trimmed) ? trimmed : null;
};

// Recovers the entries from a malformed array string such as '["10th","Deg' by
// stripping the JSON punctuation and reading what's left. Without this a
// truncated column would read as "nothing selected" and blank a volunteer's
// record, which is the one outcome worth going this far to avoid.
const salvageArrayText = (text) => {
  const inner = text.replace(/[[\]]/g, '');
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
};

const cleanOther = (value) => {
  const s = typeof value === 'string' ? value.trim() : '';
  // Bounded so a pasted essay cannot end up printed on the ODAR letter.
  return s.slice(0, 120);
};

// Drops anything not on the list, de-duplicates, and returns the selection in
// DOC_OPTIONS order so the stored value and every rendering of it are stable
// regardless of the order the boxes were ticked in.
const normalizeSelection = (list) => {
  const picked = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const opt = normalizeDocumentsValue(item);
    if (opt) picked.add(opt);
  }
  return DOC_OPTIONS.filter((opt) => picked.has(opt));
};

// Accepts a JSON array string, a real array, a single option string, or nothing,
// and reports what it means. Never throws: a corrupt column must not take down
// the worker list or the letter, it just reads as "nothing selected".
export const parseDocumentsValue = (raw, otherRaw = '') => {
  let selected = [];
  if (Array.isArray(raw)) {
    selected = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) {
      // An opening bracket means this was meant to be a list. If it will not
      // parse, it was truncated or hand-edited, so salvage the whole-string
      // reading below — the entries are usually still recognisable.
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          selected = Array.isArray(parsed) ? parsed : [trimmed];
        } catch {
          selected = salvageArrayText(trimmed);
        }
      } else {
        selected = [trimmed];
      }
    }
  } else if (raw != null) {
    selected = [raw];
  }
  return {
    selected: normalizeSelection(selected),
    otherText: cleanOther(otherRaw),
  };
};

// The inverse. Returns both columns so a caller cannot update one and forget the
// other, which is how an "Other" name would otherwise be orphaned.
export const serializeDocuments = (selected, otherText) => {
  const picked = normalizeSelection(selected);
  const custom = cleanOther(otherText);
  const isOther = picked.includes(OTHER_DOC);
  return {
    documents_value: JSON.stringify(picked),
    // The custom name only means anything while "Other" is still ticked, so
    // unchecking Other drops it rather than leaving it to resurface.
    documents_other: isOther ? custom : '',
  };
};

// What actually gets printed and shown in the "Original Document Submitted"
// table. "Other" is replaced by the volunteer's own words when they gave one, and
// is dropped entirely when they ticked it but never typed a name — printing a
// bare "Other" in a legal acknowledgement tells nobody anything.
export const resolveDocumentLabels = (selected, otherText) => {
  const picked = normalizeSelection(selected);
  const custom = cleanOther(otherText);
  return picked
    .map((opt) => (opt === OTHER_DOC ? custom : opt))
    .filter((label) => label);
};
