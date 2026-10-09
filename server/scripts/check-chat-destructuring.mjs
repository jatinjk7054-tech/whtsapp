/**
 * Flags the exact construct that caused a production crash, and nothing else.
 *
 * chatTime.js did:
 *
 *   const [y, m, dd] = partsFmt.formatToParts(d).reduce((acc, p) => { ... }, {})
 *
 * `reduce` with a `{}` accumulator returns an object; destructuring that as an
 * array throws "object is not iterable (cannot read property
 * Symbol(Symbol.iterator))" at runtime. Because the message thread renders a
 * day separator through that helper, one line took down the whole Community page
 * - and the build stayed green throughout.
 *
 * A general "is this destructuring an array?" checker is hopeless without a type
 * checker, so this matches the specific, recognisable shape instead: a `.reduce`
 * whose accumulator is an object literal. Low noise, and it is the real bug.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';

const DIR = new URL('../../client/src/components/chat/', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (['.js', '.jsx'].includes(extname(name))) out.push(p);
  }
  return out;
}

// A `.reduce(...)` whose last argument is an object literal accumulator. Matched
// across newlines, because the real call is formatted over five lines and a
// per-line scan misses it entirely - which is exactly what the first version of
// this script did.
const REDUCE_OBJ_ACC = /\.reduce\s*\((?:(?!\.reduce)[\s\S])*?,\s*\{\s*\}\s*\)/g;

// The statement holding the call, to see whether it destructures as an array.
const STMT_DECL = /(?:const|let|var)\s*([[{])/g;

const findings = [];
for (const file of walk(DIR)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(REDUCE_OBJ_ACC)) {
    // Walk back to the start of the enclosing declaration.
    const before = src.slice(0, m.index);
    const decl = [...before.matchAll(STMT_DECL)].pop();
    if (!decl) continue;
    // An array opening `[` means the object is being destructured as an array.
    if (decl[1] !== '[') continue;
    const line = before.slice(decl.index).split('\n').length;
    findings.push({
      rel: file.replace(DIR, ''),
      line,
      text: src.slice(decl.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(),
    });
  }
}

if (!findings.length) {
  console.log('chat: no object-accumulator reduce found');
  process.exit(0);
}
console.log(`chat: ${findings.length} object-accumulator reduce call(s) - confirm each is not destructured as an array:`);
for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.text}`);
process.exit(1);
