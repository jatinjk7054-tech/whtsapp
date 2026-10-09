import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-backup";
const { BackupClient, ListBackupPlansCommand, DescribeBackupPlanCommand, CreateBackupSelectionCommand, DeleteBackupPlanCommand, CreateBackupPlanCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const backup = new BackupClient({ region: "ap-south-1" });
const ACCOUNT_ID = "938364502045";
const RDS_ARN = `arn:aws:rds:ap-south-1:${ACCOUNT_ID}:db:ucs-crm-db`;
const BACKUP_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/aws-service-role/backup.amazonaws.com/AWSServiceRoleForBackup`;

async function main() {
  console.log("=== Checking Existing Backup Plans ===\n");
  
  const { BackupPlansList } = await backup.send(new ListBackupPlansCommand({}));
  
  for (const plan of BackupPlansList || []) {
    console.log(`Plan: ${plan.BackupPlanName} (ID: ${plan.BackupPlanId})`);
    console.log(`  Created: ${plan.CreationDate}`);
    
    const details = await backup.send(new DescribeBackupPlanCommand({ BackupPlanId: plan.BackupPlanId }));
    if (details.BackupPlan?.Rules) {
      for (const rule of details.BackupPlan.Rules) {
        console.log(`  Rule: ${rule.RuleName}`);
        console.log(`    TargetBackupVaultName: ${rule.TargetBackupVaultName}`);
        console.log(`    Schedule: ${rule.ScheduleExpression}`);
        console.log(`    Retention: ${rule.Lifecycle?.DeleteAfterDays} days`);
      }
    }
  }
  
  // Now try creating selection
  const plan = BackupPlansList?.find(p => p.BackupPlanName === "ucs-crm-rds-backup-plan");
  if (!plan) {
    console.log("\nNo backup plan found!");
    return;
  }
  
  console.log(`\n=== Creating Backup Selection for plan ${plan.BackupPlanId} ===`);
  
  try {
    await backup.send(new CreateBackupSelectionCommand({
      BackupPlanId: plan.BackupPlanId,
      BackupSelection: {
        SelectionName: "ucs-crm-rds-selection",
        IamRoleArn: BACKUP_ROLE_ARN,
        Resources: [RDS_ARN]
      }
    }));
    console.log("✓ Backup selection created successfully!");
  } catch (e) {
    console.error("✗ Selection creation failed:", e.message);
    if (e.message.includes("iam:PassRole")) {
      console.log("\nACTION REQUIRED: Add iam:PassRole permission to ucs-crm-backup-admin user.");
      console.log("Go to: AWS Console > IAM > Users > ucs-crm-backup-admin > Add permissions > Inline policy");
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
