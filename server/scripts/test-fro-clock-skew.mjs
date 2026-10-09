// Models the client's disposition countdown to prove it is immune to a wrong
// PC clock. OLD logic compared the server's deadline against the local wall
// clock; NEW logic counts the server's own "seconds left" down using only
// locally-elapsed time. Run: node scripts/test-fro-clock-skew.mjs

const MIN = 60 * 1000;
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

// OLD: left = deadline - Date.now()
function oldLeft(deadlineIso, localNow) {
  return Math.max(0, Math.round((new Date(deadlineIso).getTime() - localNow) / 1000));
}
// NEW: left = serverSeconds - (performance.now() - at)
function newLeft(seed) {
  return Math.max(0, Math.round(seed.seconds - (seed.elapsedNow - seed.at) / 1000));
}

const trueNow = new Date('2026-09-28T10:00:00.000Z').getTime();
// Server arms a fresh 4-minute window and reports its own remaining seconds.
const freshDeadline = new Date(trueNow + 4 * MIN).toISOString();

console.log('--- a laptop whose clock is 10 MINUTES FAST (the reported bug) ---');
const skewed = trueNow + 10 * MIN;
ok('OLD shows a fresh window as expired', oldLeft(freshDeadline, skewed) === 0);
ok('NEW still shows a full 4:00', newLeft({ seconds: 240, at: 0, elapsedNow: 0 }) === 240);
ok('NEW counts down normally despite the skew', newLeft({ seconds: 240, at: 0, elapsedNow: 30 * 1000 }) === 210);

console.log('\n--- an hour FAST and an hour SLOW ---');
ok('OLD: 1h fast pins it at 0:00', oldLeft(freshDeadline, trueNow + 60 * MIN) === 0);
ok('OLD: 1h slow shows a bogus 64 minutes', oldLeft(freshDeadline, trueNow - 60 * MIN) === 3840);
ok('NEW is unaffected either way',
  newLeft({ seconds: 240, at: 0, elapsedNow: 0 }) === 240);

console.log('\n--- Resume (server reports a fresh 240) must read 4:00 ---');
ok('NEW shows exactly 4:00 right after Resume', newLeft({ seconds: 240, at: 0, elapsedNow: 0 }) === 240);
ok('and never a stuck 0:00', newLeft({ seconds: 240, at: 0, elapsedNow: 0 }) !== 0);

console.log('\n--- genuine expiry still reaches 0:00 and holds there ---');
ok('NEW hits 0 after the full window', newLeft({ seconds: 240, at: 0, elapsedNow: 240 * 1000 }) === 0);
ok('NEW stays 0 and never goes negative', newLeft({ seconds: 240, at: 0, elapsedNow: 999 * 1000 }) === 0);

console.log('\n--- an overdue window stays at 0:00 until they act ---');
ok('server reporting 0 stays 0', newLeft({ seconds: 0, at: 0, elapsedNow: 5000 }) === 0);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
