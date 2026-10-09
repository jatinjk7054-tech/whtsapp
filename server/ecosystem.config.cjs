// PM2 process definition for the backend. Bounds the Node heap so the process
// stops growing before the host runs out of memory.
//
// These limits were originally written for a 2 GB box and were never updated
// when the host grew to 15.8 GB (13.8 GB available). The 640 MB old-space cap
// was the direct cause of the crash loop: V8 hit its heap ceiling, threw
// "Reached heap limit Allocation failed - JavaScript heap out of memory", and
// PM2 restarted the process. The in-app watchdog compounded it by SIGTERMing
// the process at 900 MB RSS. Restart count climbed past 850.
//
// The ceiling is now sized to the actual host, leaving room for Caddy
// (~605 MB), the OS, and bursty jobs, so a legitimate large job is no longer
// killed mid-flight. The ladder is deliberate and must stay ordered:
//
//   --max-old-space-size  V8 heap cap; GC pressure begins well below this
//   MEM_WATCHDOG_MB       in-app RSS watchdog; trips first, on sustained use
//   max_memory_restart    PM2 backstop; last line of defence
//
// If the process still climbs to the watchdog ceiling, that is a real leak
// rather than a too-small cap -- the fix belongs in the code, not in raising
// these numbers indefinitely.
module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: __dirname,
      script: 'src/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // PM2 restarts us before the OS OOM-killer can take the box down.
      // 6 GB leaves ~7 GB of the 15.8 GB host for Caddy, the OS, and bursts.
      max_memory_restart: '6000M',
      // 4 GB old-space, up from the 640 MB that caused the OOM crash loop.
      // Semi-space stays small; it only affects scavenger throughput for
      // short-lived objects.
      node_args: [
        '--max-old-space-size=4096',
        '--max-semi-space-size=32',
        '--max-http-header-size=16384',
      ],
      restart_delay: 3000,
      exp_backoff_restart_delay: 10000,
      kill_timeout: 8000,
      min_uptime: 20000,
      time: true,
      // Keep the in-app watchdog in step with the PM2 backstop above. Both live
      // here so production and any PM2 restart get the same numbers without
      // depending on a .env file being present on the box.
      env: {
        NODE_ENV: 'production',
        MEM_WATCHDOG_MB: '5000',
      },
    },
  ],
};
