// Wraps a periodic job so a slow previous run never overlaps the next tick.
// Without this, a 5-min cron job that takes longer than 5 minutes (large FCM
// token fan-out, slow DB batch, etc.) starts a second copy on the next tick —
// two in-flight copies double RSS and CPU, a third piles on top, and memory
// climbs until the box OOMs. Skipping a tick while one run is still active
// is always safe: these jobs are periodically re-fired safety nets.

export function makeNonOverlap(name, fn) {
  let busy = false;
  return async (...args) => {
    if (busy) {
      console.warn(`[noOverlap] ${name}: previous run still active — skipping this tick`);
      return;
    }
    busy = true;
    try {
      await fn(...args);
    } finally {
      busy = false;
    }
  };
}