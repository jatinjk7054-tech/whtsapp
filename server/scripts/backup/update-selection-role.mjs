import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-backup";
const { BackupClient, DeleteBackupSelectionCommand, CreateBackupSelectionCommand, ListBackupSelectionsCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const backup = new BackupClient({ region: "ap-south-1" });
const PLAN_ID = "e72face6-c6d9-4122-a0a8-7de359bf6a7f";
const CUSTOM_ROLE_ARN = "arn:aws:iam::938364502045:role/UCSCRMAWSBackupRole";

async function main() {
  console.log("Removing old backup selection...");
  
  const { BackupSelectionsList } = await backup.send(new ListBackupSelectionsCommand({
    BackupPlanId: PLAN_ID
  }));
  
  for (const sel of BackupSelectionsList || []) {
    console.log(`Deleting: ${sel.SelectionName} (${sel.SelectionId})`);
    await backup.send(new DeleteBackupSelectionCommand({
      BackupPlanId: PLAN_ID,
      SelectionId: sel.SelectionId
    }));
  }
  
  console.log("\nCreating new backup selection with custom role...");
  
  const result = await backup.send(new CreateBackupSelectionCommand({
    BackupPlanId: PLAN_ID,
    BackupSelection: {
      SelectionName: "ucs-crm-rds-selection",
      IamRoleArn: CUSTOM_ROLE_ARN,
      Resources: ["arn:aws:rds:ap-south-1:938364502045:db:ucs-crm-db"]
    }
  }));
  
  console.log("✓ Backup selection updated!");
  console.log("SelectionId:", result.SelectionId);
  console.log("Now trigger backup: node scripts/backup/trigger-backup.mjs");
}

main().catch(e => console.error(e));