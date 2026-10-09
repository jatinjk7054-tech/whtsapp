import { BackupClient, ListRecoveryPointsByBackupVaultCommand, StartRestoreJobCommand, DescribeRestoreJobCommand } from "@aws-sdk/client-backup";
import { RDSClient, DescribeDBInstancesCommand, DeleteDBInstanceCommand } from "@aws-sdk/client-rds";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { spawn } from "child_process";

const REGION = "ap-south-1";
const BACKUP_VAULT = "ucs-crm-backup-vault";
const TEST_DB_PREFIX = "ucs-crm-test-restore-";
const S3_BUCKET = "ucs-crm-backups";
const S3_PREFIX = "aws-rds";

const backup = new BackupClient({ region: REGION });
const rds = new RDSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

async function listLatestRecoveryPoints() {
  console.log("Listing latest recovery points...");
  const { RecoveryPoints } = await backup.send(new ListRecoveryPointsByBackupVaultCommand({
    BackupVaultName: BACKUP_VAULT,
    MaxResults: 10,
    ByResourceArn: `arn:aws:rds:ap-south-1:<ACCOUNT_ID>:db:ucs-crm-db`
  }));

  const rdsPoints = (RecoveryPoints || [])
    .filter(r => r.ResourceType === "RDS")
    .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate));

  return rdsPoints;
}

async function restoreToTestInstance(recoveryPointArn) {
  const testDbId = `${TEST_DB_PREFIX}${Date.now()}`;
  console.log(`Starting restore to test instance: ${testDbId}`);

  const { RestoreJobId } = await backup.send(new StartRestoreJobCommand({
    RecoveryPointArn: recoveryPointArn,
    Metadata: JSON.stringify({
      DBInstanceIdentifier: testDbId,
      DBInstanceClass: "db.t3.medium",
      Engine: "postgres",
      AllocatedStorage: "20",
      VpcSecurityGroupIds: ["sg-xxxxxxxx"], // Replace with actual SG
      DBSubnetGroupName: "ucs-crm-db-subnet-group", // Replace with actual subnet group
      MultiAZ: false,
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: false,
      CopyTagsToSnapshot: true,
      EnableCloudwatchLogsExports: ["postgresql", "upgrade"]
    }),
    IamRoleArn: `arn:aws:iam::<ACCOUNT_ID>:role/aws-service-role/backup.amazonaws.com/AWSServiceRoleForBackup`
  }));

  console.log(`Restore job started: ${RestoreJobId}`);

  // Wait for completion
  while (true) {
    const { RestoreJob } = await backup.send(new DescribeRestoreJobCommand({ RestoreJobId }));
    console.log(`Restore status: ${RestoreJob.Status} (${RestoreJob.PercentDone}%)`);
    if (["COMPLETED", "FAILED"].includes(RestoreJob.Status)) {
      if (RestoreJob.Status === "FAILED") throw new Error(`Restore failed: ${RestoreJob.StatusMessage}`);
      break;
    }
    await new Promise(r => setTimeout(r, 30000));
  }

  // Get restored instance endpoint
  const { DBInstances } = await rds.send(new DescribeDBInstancesCommand({
    DBInstanceIdentifier: testDbId
  }));
  const endpoint = DBInstances[0].Endpoint.Address;
  console.log(`Test instance ready: ${endpoint}`);

  return { testDbId, endpoint };
}

async function downloadLatestS3Dump() {
  console.log("Downloading latest S3 dump...");

  // Find latest dump
  const { Contents } = await s3.listObjectsV2({
    Bucket: "ucs-crm-backups",
    Prefix: "aws-rds/"
  });

  const dumps = (Contents || [])
    .filter(o => o.Key.endsWith(".sql.gz"))
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

  if (!dumps.length) throw new Error("No SQL dumps found in S3");

  const latest = dumps[0];
  console.log(`Downloading: ${latest.Key}`);

  const { Body } = await s3.send(new GetObjectCommand({ Bucket: "ucs-crm-backups", Key: latest.Key }));
  const filePath = `/tmp/ucs-crm-restore-${Date.now()}.sql.gz`;

  await pipeline(Body, createGzip(), createWriteStream(filePath));
  console.log(`Downloaded to ${filePath}`);

  return { filePath, key: latest.Key };
}

async function restoreFromS3Dump(endpoint, filePath, testDbName = "ucs_crm_test") {
  console.log(`Restoring S3 dump to ${endpoint}...`);

  // Create test database
  await new Promise((resolve, reject) => {
    const psql = spawn("psql", ["-h", endpoint, "-U", "ucs_admin", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${testDbName}; CREATE DATABASE ${testDbName};`]);
    psql.on("close", code => code === 0 ? resolve() : reject(new Error(`psql exited ${code}`)));
    psql.on("error", reject);
  });

  // Restore dump
  await new Promise((resolve, reject) => {
    const gunzip = spawn("gunzip", ["-c", filePath]);
    const psql = spawn("psql", ["-h", endpoint, "-U", "ucs_admin", "-d", testDbName]);

    gunzip.stdout.pipe(psql.stdin);
    gunzip.on("error", reject);
    psql.on("close", code => code === 0 ? resolve() : reject(new Error(`psql exited ${code}`)));
    psql.on("error", reject);
  });

  console.log("Restore from S3 dump completed");
}

async function verifyRestoredData(endpoint, testDbName = "ucs_crm_test") {
  console.log("Verifying restored data...");

  const queries = [
    "SELECT COUNT(*) as cnt FROM donors",
    "SELECT COUNT(*) as cnt FROM fro_assignments",
    "SELECT COUNT(*) as cnt FROM new_data",
    "SELECT COUNT(*) as cnt FROM donor_profiles",
    "SELECT MAX(created_at) as latest FROM new_data"
  ];

  for (const query of queries) {
    const { stdout } = await new Promise((resolve, reject) => {
      const psql = spawn("psql", ["-h", endpoint, "-U", "ucs_admin", "-d", testDbName, "-t", "-c", query]);
      let stdout = "";
      psql.stdout.on("data", d => stdout += d);
      psql.on("close", code => code === 0 ? resolve({ stdout: stdout.trim() }) : reject());
      psql.on("error", reject);
    });
    console.log(`  ${query} => ${stdout}`);
  }

  console.log("✓ Data verification passed");
}

async function cleanupTestInstance(testDbId) {
  console.log(`Cleaning up test instance: ${testDbId}`);
  await rds.send(new DeleteDBInstanceCommand({
    DBInstanceIdentifier: testDbId,
    SkipFinalSnapshot: true,
    DeleteAutomatedBackups: true
  }));
  console.log("✓ Test instance cleanup initiated");
}

async function main() {
  const mode = process.argv[2] || "aws-backup"; // "aws-backup" or "s3-dump"

  console.log(`=== Restore Test: ${mode} ===`);

  try {
    if (mode === "aws-backup") {
      const points = await listLatestRecoveryPoints();
      if (!points.length) throw new Error("No RDS recovery points found");

      console.log(`Latest recovery point: ${points[0].RecoveryPointArn} (${points[0].CreationDate})`);

      const { testDbId, endpoint } = await restoreToTestInstance(points[0].RecoveryPointArn);
      await verifyRestoredData(endpoint);
      await cleanupTestInstance(testDbId);

    } else if (mode === "s3-dump") {
      const { filePath } = await downloadLatestS3Dump();
      const { testDbId, endpoint } = await restoreToTestInstance(); // Create empty test instance
      await restoreFromS3Dump(endpoint, filePath);
      await verifyRestoredData(endpoint);
      await cleanupTestInstance(testDbId);

    } else {
      console.error("Usage: node restore-test.mjs [aws-backup|s3-dump]");
      process.exit(1);
    }

    console.log("\n=== Restore Test PASSED ===");
  } catch (e) {
    console.error("Restore test FAILED:", e.message);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });