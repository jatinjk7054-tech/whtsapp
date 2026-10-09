import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-backup";
const { BackupClient, DescribeBackupJobCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const backup = new BackupClient({ region: "ap-south-1" });

async function main() {
  const jobId = "f926628f-7b84-4141-93e1-4a7a00bf1573";
  console.log(`Checking job ${jobId}...\n`);
  
  const detail = await backup.send(new DescribeBackupJobCommand({ BackupJobId: jobId }));
  console.log("State:", detail.State);
  console.log("Status:", detail.StatusMessage);
  console.log("Started:", detail.CreationDate);
  console.log("Completed:", detail.CompletionDate);
  console.log("Bytes:", detail.BackupSizeInBytes);
  console.log("Error:", detail.MessageCategory);
  console.log("ErrorCode:", detail.ErrorCode);
}

main().catch(e => console.error(e));