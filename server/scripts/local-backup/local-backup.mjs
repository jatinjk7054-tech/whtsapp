import { execFileSync, execSync } from 'child_process';
import { createReadStream, createWriteStream, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..', '..'); // .../backend
dotenv.config({ path: path.join(BACKEND_DIR, '.env') });

// ---------------------------------------------------------------------------
// Config (overridable via backend/.env)
// ---------------------------------------------------------------------------
const BUCKET = process.env.BACKUP_S3_BUCKET || 'ucs-crm-backups';
const PREFIX = process.env.LOCAL_BACKUP_S3_PREFIX || 'local-server';
const REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const RETENTION_DAYS = parseInt(process.env.LOCAL_BACKUP_RETENTION_DAYS || '14', 10);
const LOCAL_DB_URL = process.env.LOCAL_BACKUP_DATABASE_URL || process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;
const MEDIA_DIR = process.env.LOCAL_MEDIA_DIR || 'D:\\UcsCrmMedia';
const SYNC_MEDIA = process.env.LOCAL_BACKUP_MEDIA === 'true';

const PG_DUMP_CANDIDATES = [
  process.env.PG_DUMP_PATH,
  'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
  'pg_dump',
].filter(Boolean);

const pgDump = PG_DUMP_CANDIDATES.find((p) => {
  try { execSync(`"${p}" --version`, { stdio: 'ignore' }); return true; } catch { return false; }
});

if (!pgDump) {
  console.error('[backup] pg_dump not found. Install PostgreSQL or set PG_DUMP_PATH in backend/.env');
  process.exit(1);
}
if (!LOCAL_DB_URL || !/^postgres/.test(LOCAL_DB_URL)) {
  console.error('[backup] Local DATABASE_URL (postgres://) not set in backend/.env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AWS client (reuse credentials from env or default chain)
// ---------------------------------------------------------------------------
function makeS3() {
  const cfg = { region: REGION };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  return new S3Client(cfg);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dateStr = stamp.slice(0, 10);
  const tmpDir = path.join(os.tmpdir(), 'ucs-crm-local-backup');
  mkdirSync(tmpDir, { recursive: true });
  const stampNoExt = `ucs-crm-db-${stamp}`;
  const dumpFile = path.join(tmpDir, `${stampNoExt}.dump`);
  const gzFile = path.join(tmpDir, `${stampNoExt}.dump.gz`);
  const dbKey = `${PREFIX}/${dateStr}/${path.basename(gzFile)}`;
  const client = makeS3();

  console.log('[backup] start', new Date().toISOString());

  // 1) DB dump -> gzip -> S3
  try {
    console.log(`[backup] dumping local DB to ${dumpFile}`);
    execFileSync(pgDump, [
      '--no-owner', '--no-privileges', '--format=custom',
      '--file=' + dumpFile,
      '--dbname=' + LOCAL_DB_URL,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });

    const size = statSync(dumpFile).size;
    console.log(`[backup] dump bytes: ${size}`);

    // gzip the dump
    await pipeline(
      createReadStream(dumpFile),
      createGzip(),
      createWriteStream(gzFile)
    );

    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: dbKey,
      Body: createReadStream(gzFile),
      ContentType: 'application/gzip',
    }));
    console.log(`[backup] DB uploaded s3://${BUCKET}/${dbKey} (${statSync(gzFile).size} bytes gz)`);
  } catch (e) {
    console.error('[backup] DB step FAILED:', e && e.message ? e.message : e);
    process.exitCode = 1;
  }

  // 2) Media mirror -> S3 (incremental sync)
  if (SYNC_MEDIA && existsSync(MEDIA_DIR)) {
    try {
      const mediaKey = `${PREFIX}/media/${dateStr}`;
      console.log(`[backup] syncing media ${MEDIA_DIR} -> s3://${BUCKET}/${mediaKey}`);
      const awsCli = process.env.AWS_CLI_PATH || 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';
      execFileSync(awsCli, [
        's3', 'sync', MEDIA_DIR, `s3://${BUCKET}/${mediaKey}`,
        '--region', REGION, '--no-progress',
      ], { stdio: ['ignore', 'inherit', 'inherit'] });
      console.log('[backup] media sync complete');
    } catch (e) {
      console.error('[backup] media step FAILED:', e && e.message ? e.message : e);
      process.exitCode = 1;
    }
  } else {
    console.log('[backup] media sync skipped (LOCAL_BACKUP_MEDIA not true or dir missing)');
  }

  console.log('[backup] done', new Date().toISOString());
}

main();
