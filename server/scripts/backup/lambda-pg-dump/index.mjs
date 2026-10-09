import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { spawn } from "child_process";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";

const REGION = "ap-south-1";
const S3_BUCKET = "ucs-crm-backups";
const S3_PREFIX = "aws-rds";
const SECRET_NAME = "ucs-crm/rds-password";

const RDS_HOST = process.env.RDS_HOST || "ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com";
const RDS_PORT = process.env.RDS_PORT || "5432";
const RDS_DATABASE = process.env.RDS_DATABASE || "postgres";
const RDS_USER = process.env.RDS_USER || "ucs_app";
const PG_DUMP_PATH = process.env.PG_DUMP_PATH || "/opt/pg_dump/bin/pg_dump";

const s3 = new S3Client({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });

async function getRdsPassword() {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  return SecretString;
}

async function runPgDump(password) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: password };
    const args = [
      "-h", RDS_HOST,
      "-p", RDS_PORT,
      "-U", RDS_USER,
      "-d", RDS_DATABASE,
      "--no-owner",
      "--no-privileges",
      "--format=plain",
      "--no-sync"
    ];

    const pgDump = spawn(PG_DUMP_PATH, args, { env });
    const gzip = createGzip({ level: 6 });
    const chunks = [];

    pgDump.stdout.pipe(gzip).on("data", chunk => chunks.push(chunk));
    pgDump.stderr.on("data", d => console.error("pg_dump stderr:", d.toString()));
    pgDump.on("close", code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`pg_dump exited with code ${code}`));
    });
    pgDump.on("error", reject);
  });
}

async function uploadToS3(buffer, key) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "application/gzip",
    ContentEncoding: "gzip",
    Metadata: {
      source: "aws-rds",
      database: RDS_DATABASE,
      host: RDS_HOST,
      dumpedAt: new Date().toISOString()
    }
  }));
}

export const handler = async (event) => {
  console.log("Starting pg_dump backup...");
  const startTime = Date.now();

  try {
    const password = await getRdsPassword();
    console.log("Retrieved RDS password from Secrets Manager");

    const dateStr = new Date().toISOString().split("T")[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const s3Key = `${S3_PREFIX}/${dateStr}/ucs-crm-db-${timestamp}.sql.gz`;
    const metaKey = `${S3_PREFIX}/${dateStr}/metadata.json`;

    console.log(`Running pg_dump to S3: ${s3Key}`);
    const dumpBuffer = await runPgDump(password);
    console.log(`pg_dump completed: ${dumpBuffer.length} bytes`);

    await uploadToS3(dumpBuffer, s3Key);
    console.log("Uploaded dump to S3");

    // Upload metadata
    const metadata = {
      source: "aws-rds",
      database: RDS_DATABASE,
      host: RDS_HOST,
      dumpedAt: new Date().toISOString(),
      sizeBytes: dumpBuffer.length,
      s3Key
    };
    await uploadToS3(Buffer.from(JSON.stringify(metadata, null, 2)), metaKey);
    console.log("Uploaded metadata to S3");

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Backup completed in ${duration}s`);

    return { statusCode: 200, body: { s3Key, size: dumpBuffer.length, duration } };
  } catch (err) {
    console.error("Backup failed:", err);
    throw err;
  }
};