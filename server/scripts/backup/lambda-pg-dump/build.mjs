import { execSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LAMBDA_DIR = __dirname;
const BUILD_DIR = join(LAMBDA_DIR, "build");
const PG_DUMP_VERSION = "17.0";
const PG_DUMP_URL = `https://github.com/postgres/postgres/archive/refs/tags/REL_${PG_DUMP_VERSION.replace(".", "_")}.tar.gz`;

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = require("fs").createWriteStream(dest);
    https.get(url, response => {
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

async function main() {
  console.log("=== Building Lambda pg-dump deployment package ===\n");

  // Clean build directory
  if (existsSync(BUILD_DIR)) {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  }
  mkdirSync(BUILD_DIR, { recursive: true });

  // 1. Install npm dependencies
  console.log("1. Installing npm dependencies...");
  execSync("npm install --production", { cwd: LAMBDA_DIR, stdio: "inherit" });

  // 2. Copy source files
  console.log("2. Copying source files...");
  execSync("cp -r *.mjs node_modules package.json build/", { cwd: LAMBDA_DIR, shell: "/bin/bash" });

  // 3. Download pg_dump binary (static Linux build)
  console.log("3. Downloading pg_dump binary for Linux...");
  const pgDumpDir = join(BUILD_DIR, "bin");
  mkdirSync(pgDumpDir, { recursive: true });

  // Use a pre-built static pg_dump from a reliable source
  // For simplicity, we'll use the AWS Lambda layer approach or download from EDB
  // Here we'll try to get a static binary
  const pgDumpBinary = join(pgDumpDir, "pg_dump");
  
  // Try to download from a static build source
  // Using EDB's static builds or similar
  const staticPgDumpUrl = "https://get.enterprisedb.com/postgresql/postgresql-17.0-1-linux-x64-binaries.tar.gz";
  
  console.log("   (Note: In production, use a Lambda layer with pg_dump)");
  console.log("   For now, creating placeholder - replace with actual binary");
  
  // Create a placeholder - in real deployment, you'd download actual binary
  // For now, we'll note that a Lambda layer should be used
  
  // 4. Create deployment zip
  console.log("4. Creating deployment zip...");
  execSync("cd build && zip -r ../backup-pg-dump.zip . -q", { cwd: LAMBDA_DIR, shell: "/bin/bash" });

  console.log("\n=== Build Complete ===");
  console.log(`Package: ${join(LAMBDA_DIR, "backup-pg-dump.zip")}`);
  console.log("\nNext steps:");
  console.log("1. Add pg_dump binary to build/bin/ (or use Lambda layer)");
  console.log("2. Deploy: aws lambda update-function-code --function-name ucs-crm-backup-pg-dump --zip-file fileb://backup-pg-dump.zip --region ap-south-1");
}

main().catch(e => { console.error(e); process.exit(1); });