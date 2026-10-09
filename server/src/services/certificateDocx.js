import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

// Certificate template engine — DOCX and PPTX are both OpenXML Zip packages, so
// the same docxtemplater core handles both. Placeholders are plain {field_name}
// text runs; they are DATA ONLY and never executed. The original template file
// is never modified (render always starts from a fresh copy of the stored file).

const TAG_RE = /\{\s*([A-Za-z0-9_.-]+?)\s*\}/g;
const SPACE_TAG_RE = /\{\s{1,}([A-Za-z0-9_.-]+?)\s*\}|\{\s*([A-Za-z0-9_.-]+?)\s{1,}\}/g;

function decodeEntry(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content.asText === 'function') {
    try { return content.asText() || ''; } catch { /* fall through */ }
  }
  if (content instanceof Uint8Array || ArrayBuffer.isView(content)) return new TextDecoder().decode(content);
  return '';
}

function entryTextLike(content) {
  return /<\s*(w:t|a:t)\b/.test(content);
}

export function getPkgFormat(buffer) {
  try {
    const zip = new PizZip(buffer);
    const names = Object.keys(zip.files || {});
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('ppt/presentation.xml') || names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return 'pptx';
    return null;
  } catch {
    return null;
  }
}

// Rewrite "{ name }" / "{name }" / "{ name}" → "{name}" inside the raw OpenXML
// text runs so docxtemplater can both detect and fill them. The stored template
// keeps the whitespace-stripped form; only text inside a tag is touched.
export function normalizePlaceholderWhitespace(buffer) {
  const zip = new PizZip(buffer);
  for (const path of Object.keys(zip.files || {})) {
    const entry = zip.files[path];
    if (!entry || entry.dir) continue;
    const content = zip.file(path);
    if (content == null) continue;
    const decoded = decodeEntry(content);
    if (!entryTextLike(decoded)) continue;
    zip.file(path, decoded.replace(SPACE_TAG_RE, (m, a, b) => `{${(a || b)}}`));
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function collectFromText(text, out) {
  if (!text) return;
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) out.add(m[1].trim());
}

// Fallback used when getFullText() isn't available (some package types): scan
// every text-bearing XML entry, run by run. Tags split across runs are the
// reason getFullText() is preferred, but this still catches the common cases.
function collectFromEntryText(content, out) {
  const runs = String(content).match(/<\s*(?:w:t|a:t)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:w:t|a:t)\s*>/g) || [];
  for (const run of runs) collectFromText(run, out);
}

// Docxtemplater wraps everything it finds wrong in a single error whose message
// is the literal string "Multi error"; the actionable text lives one level down
// in properties.errors[].properties.explanation. Without this, every bad
// template looks identical to the user.
// Docxtemplater wraps everything it finds wrong in a single error whose message
// is the literal string "Multi error"; the actionable text lives one level down
// in properties.errors[].properties.explanation. Without this, every bad
// template looks identical to the user.
function describeDocxError(e) {
  const one = (err) => {
    const p = (err && err.properties) || {};
    const text = p.explanation || err?.message || String(err);
    const tag = p.xtag || p.value;
    const part = String(p.part || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (tag && part && !text.includes(tag)) return `${text} (near "${part}")`;
    return text;
  };

  const subs = e?.properties?.errors;
  if (Array.isArray(subs) && subs.length) {
    const first = one(subs[0]);
    if (subs.length === 1) return first;
    return `${first} (+${subs.length - 1} more)`;
  }
  return one(e);
}

// An unreadable/invalid template is the caller's mistake, not ours: 400, not 500.
export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
    this.status = 400;
    this.expose = true;
  }
}

export const humanizeKey = (k) =>
  String(k)
    .split('.')
    .join(' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || String(k);

export function detectPlaceholders(buffer) {
  let zip;
  let doc;
  try {
    zip = new PizZip(buffer);
    doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  } catch (e) {
    throw new TemplateError(`Unreadable template — ${describeDocxError(e)}`);
  }

  const keys = new Set();
  let previewText = '';
  try {
    const full = doc.getFullText() || '';
    previewText = String(full).slice(0, 400);
    collectFromText(full, keys);
  } catch (_) {
    for (const path of Object.keys(zip.files || {})) {
      if (zip.files[path].dir) continue;
      const decoded = decodeEntry(zip.file(path));
      if (!entryTextLike(decoded)) continue;
      collectFromEntryText(decoded, keys);
    }
  }

  // Union with the raw text runs regardless of which path above ran, so a split
  // tag that getFullText() could not merge is still not lost.
  try {
    collectFromText(doc.getFullText() || '', keys);
  } catch (_) { /* noop */ }

  return {
    placeholders: [...keys]
      .filter((k) => /^[A-Za-z0-9_.-]+$/.test(k))
      .map((key) => ({ key, display: humanizeKey(key) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    previewText,
  };
}

export function renderCertificate(buffer, values) {
  let zip;
  let doc;
  try {
    zip = new PizZip(buffer);
    doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  } catch (e) {
    throw new TemplateError(`Unreadable template — ${describeDocxError(e)}`);
  }
  const data = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (v == null) continue;
    data[k] = String(v);
  }
  try {
    doc.render(data);
  } catch (e) {
    throw new TemplateError(`Could not fill template — ${describeDocxError(e)}`);
  }
  const ext = getPkgFormat(buffer);
  const mime =
    ext === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return {
    buffer: doc.getZip().generate({ type: 'nodebuffer', mimeType: mime }),
    ext: ext === 'pptx' ? 'pptx' : 'docx',
    mime,
  };
}