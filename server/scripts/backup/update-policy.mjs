import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-iam";
const { IAMClient, GetUserPolicyCommand, PutUserPolicyCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const iam = new IAMClient({ region: "ap-south-1" });

async function main() {
  console.log("Updating IAM policy to include new backup role...");
  
  const { PolicyDocument } = await iam.send(new GetUserPolicyCommand({
    UserName: "ucs-crm-backup-admin",
    PolicyName: "UCSCRM-IAM-Roles-Management"
  }));
  
  const policy = JSON.parse(decodeURIComponent(PolicyDocument));
  
  // Add the new backup role to resources
  policy.Statement[0].Resource.push(
    "arn:aws:iam::938364502045:role/UCS-CRM-AWSBackup-Role"
  );
  
  await iam.send(new PutUserPolicyCommand({
    UserName: "ucs-crm-backup-admin",
    PolicyName: "UCSCRM-IAM-Roles-Management",
    PolicyDocument: JSON.stringify(policy)
  }));
  
  console.log("✓ Policy updated");
}

main().catch(e => console.error(e));