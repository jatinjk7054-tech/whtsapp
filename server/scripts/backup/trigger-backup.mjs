import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-backup";
const { BackupClient, StartBackupJobCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const backup = new BackupClient({ region: "ap-south-1" });

async function main() {
  console.log("Starting manual backup job...");
  
  try {
    const result = await backup.send(new StartBackupJobCommand({
      BackupVaultName: "ucs-crm-backup-vault",
      ResourceArn: "arn:aws:rds:ap-south-1:938364502045:db:ucs-crm-db",
      IamRoleArn: "arn:aws:iam::938364502045:role/UCSCRMAWSBackupRole"
    }));
    
    console.log("✓ Backup job started!");
    console.log("BackupJobId:", result.BackupJobId);
    console.log("CreationDate:", result.CreationDate);
    console.log("State:", result.State);
  } catch (e) {
    console.error("Error:", e.message);
    console.error("Code:", e.Code);
  }
}

main();