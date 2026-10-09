import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-iam";
const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand, GetRoleCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const iam = new IAMClient({ region: "ap-south-1" });
const ROLE_NAME = "UCS-CRM-AWSBackup-Role";
const ACCOUNT_ID = "938364502045";

async function main() {
  console.log("Creating custom AWS Backup role...");
  
  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "backup.amazonaws.com" },
      Action: "sts:AssumeRole"
    }]
  };
  
  try {
    const { Role } = await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description: "Custom role for AWS Backup to access RDS",
      Tags: [{ Key: "Project", Value: "UCS-CRM" }]
    }));
    console.log("✓ Role created:", Role.Arn);
  } catch (e) {
    if (e.name === "EntityAlreadyExistsException") {
      console.log("✓ Role already exists");
    } else throw e;
  }
  
  // Attach AWS managed policy for backup
  await iam.send(new AttachRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
  }));
  console.log("✓ Attached AWSBackupServiceRolePolicyForBackup");
  
  // Add RDS permissions
  const rdsPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: [
        "rds:DescribeDBInstances",
        "rds:ListTagsForResource"
      ],
      Resource: "*"
    }]
  };
  
  await iam.send(new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: "RDSAccess",
    PolicyDocument: JSON.stringify(rdsPolicy)
  }));
  console.log("✓ Added RDS permissions");
  
  const { Role } = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  console.log("\nRole ARN:", Role.Arn);
  console.log("\nNow update backup selection to use this role:");
  console.log(`  IamRoleArn: ${Role.Arn}`);
}

main().catch(e => console.error(e));