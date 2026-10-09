import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// A headless LibreOffice conversion holds a child soffice.bin that can consume
// ~300-500MB of RSS. Bulk certificate/preview generation used to launch one
// conversion per request concurrently, stacking many child processes on the
// 2GB host until the watchdog/OOM killer intervened. Single-flight serializes
// them: while one conversion is running, additional requests are answered null
// (the shared contract is "best-effort snapshot; manual upload otherwise").
let conversionInFlight = false;

// Renders the first page/slide of a .docx / .pptx to a PNG using LibreOffice
// headless. Returns a PNG buffer, or null when soffice is unavailable or
// rendering fails (the caller treats null as "no auto snapshot", never as an error).
export async function snapshotToPng(buffer, ext = 'pptx') {
  if (conversionInFlight) return null;
  conversionInFlight = true;
  try {
    return await renderSnapshotToPng(buffer, ext);
  } finally {
    conversionInFlight = false;
  }
}

async function renderSnapshotToPng(buffer, ext = 'pptx') {
  if (!buffer || !buffer.length) return null;
  const safeExt = ext === 'docx' ? 'docx' : 'pptx';
  const dir = mkdtempSync(path.join(tmpdir(), 'cert-slide-'));
  const src = path.join(dir, `input.${safeExt}`);
  // Each run gets an isolated LibreOffice user profile. Without it, LibreOffice
  // reuses a daemonized instance keyed on the shared ~/.config profile and can
  // leave a resident soffice.bin (~300-500MB) behind that never exits.
  const profile = path.join(dir, 'lo-profile');
  const profileUrl = 'file://' + profile;
  try {
    writeFileSync(src, buffer);
    let stdout = '';
    try {
      const res = await execFileAsync('soffice', [
        `-env:UserInstallation=${profileUrl}`,
        '--headless',
        '--convert-to', 'png',
        '--outdir', dir,
        src,
      ], { timeout: 60000 });
      stdout = res.stdout || '';
    } catch (e) {
      // soffice not installed on the host -> no auto snapshot, stay on manual upload.
      if (e.code === 'ENOENT') return null;
      // LibreOffice can still succeed despite a non-zero exit in some builds; verify output below.
      stdout = String(e.stdout || '');
    }
    const out = path.join(dir, 'input.png');
    if (!existsSync(out)) return null;
    return readFileSync(out);
  } finally {
    // Kill any processes still attached to this run's profile. The unique
    // profile path appears in the soffice command line, so pkill -f only
    // matches this run's orphaned processes, never concurrent conversions.
    try {
      await execFileAsync('pkill', ['-f', profile], { timeout: 5000 });
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}