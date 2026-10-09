import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-iam";
const { IAMClient, PutRolePolicyCommand, GetRolePolicyCommand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const iam = new IAMClient({ region: "ap-south-1" });
const ROLE_NAME = "AWSServiceRoleForBackup";

async function main() {
  console.log("Adding rds:ListTagsForResource permission to service-linked role...\n");
  
  const policyDoc = {
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
  
  try {
    await iam.send(new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: "RDSAccessForBackup",
      PolicyDocument: JSON.stringify(policyDoc)
    }));
    console.log("✓ Inline policy added to service-linked role!");
    console.log("Policy name: RDSAccessForBackup");
    console.log("Actions: rds:DescribeDBInstances, rds:ListTagsForResource");
  } catch (e) {
    console.error("Error:", e.message);
    console.error("Code:", e.Code);
    if (e.Code === "AccessDenied") {
      console.log("\n⚠ Service-linked role may not allow inline policies.");
      console.log("Alternative: Use AWS Console or create custom role (update-selection-role.mjs)");
    }
  }
}

main().catch(e => console.error(e));