import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { S3Client, ListBucketsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { BackupClient, ListBackupVaultsCommand, ListBackupPlansCommand } from "@aws-sdk/client-backup";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { fromEnv } from "@aws-sdk/credential-provider-env";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const REGION = process.env.AWS_REGION || "ap-south-1";
const creds = fromEnv();

const rds = new RDSClient({ region: REGION, credentials: creds });
const s3 = new S3Client({ region: REGION, credentials: creds });
const backup = new BackupClient({ region: REGION, credentials: creds });
const cw = new CloudWatchClient({ region: REGION, credentials: creds });

async function checkRDS() {
  console.log("\n=== RDS Instances ===");
  const { DBInstances } = await rds.send(new DescribeDBInstancesCommand({}));
  for (const db of DBInstances) {
    console.log(`  Instance: ${db.DBInstanceIdentifier}`);
    console.log(`    Engine: ${db.Engine} ${db.EngineVersion}`);
    console.log(`    Class: ${db.DBInstanceClass}`);
    console.log(`    Storage: ${db.AllocatedStorage} GB (${db.StorageType})`);
    console.log(`    Multi-AZ: ${db.MultiAZ}`);
    console.log(`    Status: ${db.DBInstanceStatus}`);
    console.log(`    Backup Retention: ${db.BackupRetentionPeriod} days`);
    console.log(`    Encrypted: ${db.StorageEncrypted}`);
    console.log(`    Endpoint: ${db.Endpoint?.Address}:${db.Endpoint?.Port}`);
    console.log(`    Created: ${db.InstanceCreateTime}`);
    const pricing = { "db.t3.micro": 14.5, "db.t3.small": 29, "db.t3.medium": 58, "db.t3.large": 116 };
    const monthly = pricing[db.DBInstanceClass] || 0;
    const storageCost = (db.AllocatedStorage || 20) * 0.115;
    console.log(`    Est. Monthly: ~$${(monthly + storageCost).toFixed(2)} (instance: $${monthly}, storage: $${storageCost.toFixed(2)})`);
  }
}

async function checkS3() {
  console.log("\n=== S3 Buckets ===");
  const { Buckets } = await s3.send(new ListBucketsCommand({}));
  for (const bucket of Buckets) {
    console.log(`  Bucket: ${bucket.Name} (Created: ${bucket.CreationDate})`);
    try {
      let totalSize = 0;
      let objectCount = 0;
      let continuationToken;
      do {
        const { Contents, NextContinuationToken } = await s3.send(new ListObjectsV2Command({ Bucket: bucket.Name, ContinuationToken: continuationToken }));
        if (Contents) { for (const obj of Contents) { totalSize += obj.Size; objectCount++; } }
        continuationToken = NextContinuationToken;
      } while (continuationToken);
      const sizeGB = (totalSize / (1024**3)).toFixed(2);
      console.log(`    Objects: ${objectCount}, Size: ${sizeGB} GB`);
      console.log(`    Est. Monthly: ~$${(sizeGB * 0.023).toFixed(4)} (Standard) or $${(sizeGB * 0.004).toFixed(4)} (Glacier)`);
    } catch (e) {
      console.log(`    Could not list objects: ${e.message}`);
    }
  }
}

async function checkBackup() {
  console.log("\n=== AWS Backup ===");
  try {
    const { BackupVaultList } = await backup.send(new ListBackupVaultsCommand({}));
    for (const vault of BackupVaultList) console.log(`  Vault: ${vault.BackupVaultName} (${vault.CreationDate})`);
  } catch (e) { console.log(`  No backup vaults: ${e.message}`); }
  try {
    const { BackupPlansList } = await backup.send(new ListBackupPlansCommand({}));
    for (const plan of BackupPlansList) {
      console.log(`  Plan: ${plan.BackupPlanName} (${plan.BackupPlanId})`);
      console.log(`    Last Run: ${plan.LastExecutionDate || 'Never'}`);
    }
  } catch (e) { console.log(`  No backup plans: ${e.message}`); }
}

async function estimateBackupCosts() {
  console.log("\n=== Estimated Backup Costs (Monthly) ===");
  const { DBInstances } = await rds.send(new DescribeDBInstancesCommand({}));
  const db = DBInstances.find(d => d.DBInstanceIdentifier === "ucs-crm-db");
  if (db) {
    const storageGB = db.AllocatedStorage || 20;
    console.log(`\nCurrent RDS: ${db.DBInstanceClass}, ${storageGB} GB ${db.StorageType}`);
    const backupStorageGB = storageGB * 1.5;
    const backupCost = backupStorageGB * 0.05;
    console.log(`\nAWS Backup (RDS snapshots):`);
    console.log(`  Estimated backup storage: ~${backupStorageGB} GB`);
    console.log(`  Cost: ~$${backupCost.toFixed(2)}/month`);
    const dumpSizeGB = (storageGB * 0.3).toFixed(1);
    const s3StandardCost = dumpSizeGB * 0.023;
    const s3GlacierCost = dumpSizeGB * 0.004;
    console.log(`\nS3 pg_dump (every 2 days, ~${dumpSizeGB} GB each):`);
    console.log(`  Standard: $${s3StandardCost.toFixed(4)}/month`);
    console.log(`  Glacier (30+ days): $${s3GlacierCost.toFixed(4)}/month`);
    const lambdaGBHours = 3.75;
    const lambdaCost = lambdaGBHours * 0.0000166667;
    console.log(`\nLambda pg_dump (15 min x 15 runs/month):`);
    console.log(`  Cost: ~$${lambdaCost.toFixed(6)}/month`);
    const cwLogGB = 0.5;
    const cwCost = cwLogGB * 0.50;
    console.log(`\nCloudWatch Logs (~0.5 GB/month):`);
    console.log(`  Cost: ~$${cwCost.toFixed(2)}/month`);
    const total = backupCost + s3StandardCost + lambdaCost + cwCost;
    console.log(`\n=== TOTAL ESTIMATED MONTHLY BACKUP COST: $${total.toFixed(2)} ===`);
    console.log(`  (Within AWS Free Tier for first 12 months for new accounts)`);
  }
}

async function main() {
  console.log("=== UCS CRM - Current AWS Cost Analysis ===");
  await checkRDS();
  await checkS3();
  await checkBackup();
  await estimateBackupCosts();
  console.log("\n=== Free Tier Eligibility ===");
  console.log("AWS Free Tier (12 months for new accounts):");
  console.log("  - RDS: 750 hrs/month db.t2.micro/db.t3.micro (PostgreSQL)");
  console.log("  - S3: 5 GB Standard storage");
  console.log("  - Lambda: 1M requests, 400,000 GB-seconds");
  console.log("  - CloudWatch: 10 custom metrics, 10 alarms, 5 GB logs");
  console.log("  - AWS Backup: First 100 GB free");
  console.log("\nNote: Free tier expires 12 months after account creation.");
}

main().catch(e => { console.error(e); process.exit(1); });