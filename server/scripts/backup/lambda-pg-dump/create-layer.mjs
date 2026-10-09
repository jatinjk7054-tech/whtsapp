import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import * as tar from "tar";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LAYER_DIR = join(__dirname, "layer");
const BIN_DIR = join(LAYER_DIR, "bin");

const pgUrls = [
  "https://github.com/postgres/postgres/releases/download/REL_17_0/postgresql-17.0-linux-x64-binaries.tar.gz",
  "https://get.enterprisedb.com/postgresql/postgresql-17.0-1-linux-x64-binaries.tar.gz",
  "https://ftp.postgresql.org/pub/binary/v17.0/linux/x86_64/postgresql-17.0-linux-x64-binaries.tar.gz",
  "https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/postgresql-client-17.0-r0.apk",
];

async function downloadAndExtract(url, destDir) {
  console.log(`Downloading from ${url}...`);
  
  return new Promise((resolve, reject) => {
    https.get(url, async (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      await pipeline(
        response,
        createGunzip(),
        tar.extract({ cwd: destDir, strip: 1 })
      );
      resolve();
    }).on("error", reject);
  });
}

async function downloadWithRetry(urls, destDir) {
  for (const url of urls) {
    try {
      console.log(`Trying ${url}...`);
      await downloadAndExtract(url, destDir);
      console.log("Success!");
      return;
    } catch (e) {
      console.log(`Failed: ${e.message}`);
    }
  }
  throw new Error("All download sources failed");
}

async function findPgDump(dir) {
  const possiblePaths = [
    join(dir, "pgsql", "bin", "pg_dump"),
    join(dir, "bin", "pg_dump"),
    join(dir, "postgresql", "bin", "pg_dump"),
    join(dir, "usr", "bin", "pg_dump"),
  ];
  
  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function main() {
  console.log("=== Creating Lambda Layer with pg_dump ===\n");

  if (existsSync(LAYER_DIR)) rmSync(LAYER_DIR, { recursive: true, force: true });
  mkdirSync(BIN_DIR, { recursive: true });

  try {
    await downloadWithRetry(pgUrls, LAYER_DIR);
    console.log("Downloaded and extracted PostgreSQL binaries");
  } catch (e) {
    console.error("All downloads failed:", e.message);
    process.exit(1);
  }

  const pgDumpSrc = await findPgDump(LAYER_DIR);
  const pgDumpDest = join(BIN_DIR, "pg_dump");
  
  if (pgDumpSrc) {
    copyFileSync(pgDumpSrc, pgDumpDest);
    execSync(`chmod +x ${pgDumpDest}`);
    console.log(`pg_dump binary copied from ${pgDumpSrc}`);
  } else {
    console.error("pg_dump not found in extracted files");
    const found = execSync(`find "${LAYER_DIR}" -type f -name "pg_dump" 2>/dev/null`, { encoding: "utf-8" });
    console.log("Found:", found || "none");
    process.exit(1);
  }

  const layerZip = join(__dirname, "pg-dump-layer.zip");
  execSync(`cd "${LAYER_DIR}" && zip -r "${layerZip}" . -q`, { stdio: "inherit" });
  
  console.log(`\nLayer package: ${layerZip}`);
  console.log("Publish layer:");
  console.log(`aws lambda publish-layer-version --layer-name ucs-crm-pg-dump --zip-file fileb://${layerZip} --compatible-runtimes nodejs20.x --region ap-south-1`);
}

main().catch(e => { console.error(e); process.exit(1); });