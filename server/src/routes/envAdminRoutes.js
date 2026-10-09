import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Projects live at the repo root (one level above backend/).
const PROJECTS_ROOT = process.env.ENV_ADMIN_ROOT || path.resolve(__dirname, '../../..');

// The project this backend itself runs from — the only one we can compare the
// running process env against.
const SELF_DIR = path.resolve(__dirname, '../..');

// Normalise a value read from a .env line the way dotenv does (strip quotes,
// expand \n/\r/\t in double-quoted values, drop inline comments), so it can be
// compared to the value the running process actually loaded.
function normalizeFileValue(v) {
  let s = String(v == null ? '' : v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    s = s
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  } else if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    s = s.slice(1, -1);
  } else {
    s = s.replace(/\s+#.*$/, '').trim();
  }
  return s;
}

const ENV_ADMIN_KEY = process.env.ENV_ADMIN_KEY;
if (!ENV_ADMIN_KEY) {
  console.warn('WARNING: ENV_ADMIN_KEY is not set. Env admin endpoints are OPEN.');
}

const router = Router();

const requireKey = (req, res, next) => {
  if (!ENV_ADMIN_KEY) return next();
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ENV_ADMIN_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
};
router.use(requireKey);

function safeProjectDir(name) {
  const n = String(name || '').trim();
  if (!n || n.includes('/') || n.includes('\\') || n === '.' || n === '..' || n.startsWith('.')) return null;
  return path.join(PROJECTS_ROOT, n);
}

async function isDirectory(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readEnvLines(envPath) {
  try {
    return (await fs.readFile(envPath, 'utf8')).split(/\r?\n/);
  } catch {
    return [];
  }
}

async function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, filePath);
}

// List all project folders under the projects root.
router.get('/projects', async (req, res) => {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(PROJECTS_ROOT, e.name);
      let hasEnv = false;
      let envCount = 0;
      let mtime = null;
      const comparable = path.resolve(PROJECTS_ROOT, e.name) === SELF_DIR;
      let needsRestart = false;
      try {
        const lines = await readEnvLines(path.join(dir, '.env'));
        hasEnv = lines.length > 0;
        for (const line of lines) {
          const t = line.trim();
          if (t && !t.startsWith('#') && t.includes('=')) envCount++;
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (comparable && m && normalizeFileValue(m[2]) !== (process.env[m[1]] ?? null)) needsRestart = true;
        }
        mtime = (await fs.stat(path.join(dir, '.env'))).mtime.toISOString();
      } catch {}
      projects.push({ name: e.name, hasEnv, envCount, mtime, comparable, needsRestart });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ root: PROJECTS_ROOT, projects });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Read every project's .env in one call (for the "View All" screen).
router.get('/all', async (req, res) => {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(PROJECTS_ROOT, e.name);
      const envPath = path.join(dir, '.env');
      const lines = await readEnvLines(envPath);
      if (!lines.length) continue;
      const comparable = dir === SELF_DIR;
      const vars = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) {
          const deployed = comparable
            ? normalizeFileValue(m[2]) === (process.env[m[1]] ?? null)
            : null;
          const running = comparable ? process.env[m[1]] ?? null : null;
          vars.push({ key: m[1], value: m[2], line: i + 1, deployed, running });
        }
      }
      let mtime = null;
      try { mtime = (await fs.stat(envPath)).mtime.toISOString(); } catch {}
      projects.push({
        name: e.name,
        envPath: envPath.replace(PROJECTS_ROOT, '.'),
        comparable,
        needsRestart: comparable ? vars.some((v) => !v.deployed) : null,
        mtime,
        vars,
        raw: lines.join('\n'),
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ root: PROJECTS_ROOT, projects });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Read the .env of a project as key/value pairs.
router.get('/projects/:name/env', async (req, res) => {
  try {
    const dir = safeProjectDir(req.params.name);
    if (!dir) return res.status(400).json({ message: 'Invalid project name' });
    if (!(await isDirectory(dir))) return res.status(404).json({ message: 'Project not found' });

    const envPath = path.join(dir, '.env');
    const comparable = dir === SELF_DIR;
    const lines = await readEnvLines(envPath);
    const vars = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) {
        const deployed = comparable
          ? normalizeFileValue(m[2]) === (process.env[m[1]] ?? null)
          : null;
        const running = comparable ? process.env[m[1]] ?? null : null;
        vars.push({ key: m[1], value: m[2], line: i + 1, deployed, running });
      }
    }
    const needsRestart = comparable ? vars.some((v) => !v.deployed) : null;
    res.json({ name: req.params.name, envPath: envPath.replace(PROJECTS_ROOT, '.'), comparable, needsRestart, vars, raw: lines.join('\n') });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add or update a single variable. Creates .env if it does not exist yet.
router.post('/projects/:name/env', async (req, res) => {
  try {
    const dir = safeProjectDir(req.params.name);
    if (!dir) return res.status(400).json({ message: 'Invalid project name' });
    if (!(await isDirectory(dir))) return res.status(404).json({ message: 'Project not found' });

    const key = String((req.body && req.body.key) || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ message: 'Invalid key (A-Z, a-z, 0-9, _ only)' });
    const value = req.body && req.body.value != null ? String(req.body.value) : '';
    if (value.includes('\n') || value.includes('\r')) {
      return res.status(400).json({ message: 'Value cannot contain newlines' });
    }

    const envPath = path.join(dir, '.env');
    const lines = await readEnvLines(envPath);
    const re = new RegExp(`^${escapeRe(key)}\\s*=`);

    let found = false;
    const out = lines.map((line) => {
      if (!found && re.test(line)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) out.push(`${key}=${value}`);

    await atomicWrite(envPath, out.join('\n') + '\n');
    res.json({ ok: true, key, value, updated: found });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a variable from .env.
router.delete('/projects/:name/env/:key', async (req, res) => {
  try {
    const dir = safeProjectDir(req.params.name);
    if (!dir) return res.status(400).json({ message: 'Invalid project name' });
    if (!(await isDirectory(dir))) return res.status(404).json({ message: 'Project not found' });

    const key = String(req.params.key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ message: 'Invalid key' });

    const envPath = path.join(dir, '.env');
    const lines = await readEnvLines(envPath);
    const re = new RegExp(`^${escapeRe(key)}\\s*=`);

    const next = lines.filter((line) => !re.test(line));
    if (next.length === lines.length) return res.status(404).json({ message: `Key "${key}" not found` });

    await atomicWrite(envPath, next.join('\n'));
    res.json({ ok: true, key });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

async function readCpuOnce() {
  const text = await fs.readFile('/proc/stat', 'utf8');
  const parts = text.split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function readCpuUsage() {
  try {
    const a = await readCpuOnce();
    await new Promise((r) => setTimeout(r, 500));
    const b = await readCpuOnce();
    const total = b.total - a.total;
    const idle = b.idle - a.idle;
    const usage = total > 0 ? ((total - idle) / total) * 100 : 0;
    return { usagePct: Math.round(usage * 10) / 10, cores: os.cpus().length };
  } catch {
    return { usagePct: null, cores: os.cpus().length };
  }
}

function readMem() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = text.match(new RegExp(`${k}:\\s*(\\d+)`));
      return m ? parseInt(m[1], 10) * 1024 : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    if (total && avail) {
      const used = total - avail;
      return { total, used, free: avail, pct: Math.round((used / total) * 1000) / 10 };
    }
  } catch {}
  const t = os.totalmem();
  const f = os.freemem();
  return { total: t, used: t - f, free: f, pct: Math.round(((t - f) / t) * 1000) / 10 };
}

function readDisk() {
  try {
    const out = execSync(
      'df -Pk --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=overlay --exclude-type=sysfs --exclude-type=proc --exclude-type=devpts',
      { encoding: 'utf8', timeout: 5000 }
    );
    return out.trim().split('\n').slice(1).map((l) => {
      const p = l.trim().split(/\s+/);
      if (p.length < 6) return null;
      const [, totalK, usedK, availK, usePct, mount] = p;
      return { mount, total: +totalK * 1024, used: +usedK * 1024, free: +availK * 1024, pct: parseFloat(usePct.replace('%', '')) };
    }).filter((d) => d && d.total >= 1024 * 1024);
  } catch {
    return [];
  }
}

// Server load: CPU, memory, disk, uptime, load average, PM2 processes.
router.get('/system', async (req, res) => {
  try {
    const [cpu, mem, disk, pm2] = await Promise.all([
      readCpuUsage(),
      Promise.resolve(readMem()),
      Promise.resolve(readDisk()),
      (async () => {
        try {
          const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 }));
          return j.map((p) => ({
            name: p.name,
            status: (p.pm2_env && p.pm2_env.status) || 'unknown',
            restart_time: (p.pm2_env && p.pm2_env.restart_time) || 0,
            cpu: (p.monit && p.monit.cpu) || 0,
            memory: (p.monit && p.monit.memory) || 0,
            uptime_ms: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
          }));
        } catch {
          return [];
        }
      })(),
    ]);

    res.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime_seconds: Math.round(os.uptime()),
      load_avg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      node: process.version,
      cpu,
      mem,
      disk,
      pm2,
      // This process's own heap breakdown: rss vs the V8 heap we cap in
      // ecosystem.config.cjs (old-space limit) — use it to spot Buffer/native
      // growth that V8 GC can never reclaim.
      proc_mem: process.memoryUsage(),
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Top CPU/memory consumers on the host (one line per PID). Shows things PM2
// does not manage — stray soffice orphans, converters, pg_dump, etc.
router.get('/system/procs', async (req, res) => {
  try {
    const out = execSync(
      "ps -eo pid,ppid,pcpu,pmem,rss,etime,user,comm,args --sort=-rss | head -n 30",
      { encoding: 'utf8', timeout: 8000 }
    );
    const lines = out.trim().split('\n').map((l) => l.replace(/\s+/g, ' ').split(' '));
    const [, ...rows] = lines;
    const procs = rows.map((r) => ({
      pid: Number(r[0]),
      ppid: Number(r[1]),
      pcpu: parseFloat(r[2]),
      pmem: parseFloat(r[3]),
      rss_mb: Math.round((+r[4] / 1024) * 10) / 10,
      etime: r[5],
      user: r[6],
      cmd: r.slice(8).join(' '),
    }));
    res.json({ procs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Trigger a backend restart so .env changes take effect. The restart is fired
// as a detached child (with a short delay) so the response is sent before the
// current process is killed. Also kills any orphaned LibreOffice (soffice)
// processes — those are not PM2 children, so a plain restart never reclaimed
// them and they could chew hundreds of MB of RAM each.
router.post('/restart', async (req, res) => {
  try {
    const child = spawn('sh', ['-c', 'pkill -f soffice.bin; sleep 2 && pm2 restart backend --update-env'], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECTS_ROOT,
    });
    child.unref();
    res.json({ ok: true, message: 'Backend restart triggered. Reconnecting…' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
