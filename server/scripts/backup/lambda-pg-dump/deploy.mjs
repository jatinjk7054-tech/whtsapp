import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pkg from "@aws-sdk/client-lambda";
const { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand, PublishLayerVersionCommand, GetFunctionCommand, AddLayerVersionPermissionCommand, UpdateFunctionConfigurationCommand } = pkg;
import pkgIAM from "@aws-sdk/client-iam";
const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, GetRoleCommand, PutRolePolicyCommand } = pkgIAM;
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env") });

const REGION = "ap-south-1";
const FUNCTION_NAME = "ucs-crm-backup-pg-dump";
const LAYER_NAME = "ucs-crm-pg-dump";
const ROLE_NAME = "ucs-crm-backup-pg-dump-role";

const lambda = new LambdaClient({ region: REGION });
const iam = new IAMClient({ region: REGION });

async function getOrCreateExecutionRole() {
  console.log("Checking Lambda execution role...");
  
  try {
    const { Role } = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    console.log("Role exists:", Role.Arn);
    return Role.Arn;
  } catch (e) {
    if (e.name === "NoSuchEntityException") {
      console.log("Role doesn't exist, creating...");
      
      const trustPolicy = {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole"
        }]
      };

      const { Role } = await iam.send(new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: "Lambda role for pg_dump backup to S3",
        Tags: [{ Key: "Project", Value: "UCS-CRM" }]
      }));
      console.log("Role created:", Role.Arn);

      await iam.send(new AttachRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
      }));
      console.log("Attached AWSLambdaBasicExecutionRole");

      const customPolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
            Resource: ["arn:aws:s3:::ucs-crm-backups", "arn:aws:s3:::ucs-crm-backups/*"]
          },
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: "arn:aws:secretsmanager:ap-south-1:938364502045:secret:ucs-crm/rds-password*"
          },
          {
            Effect: "Allow",
            Action: ["rds:DescribeDBInstances", "ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"],
            Resource: "*"
          },
          {
            Effect: "Allow",
            Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: "*"
          }
        ]
      };

      await iam.send(new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: "PGDumpBackupPolicy",
        PolicyDocument: JSON.stringify(customPolicy)
      }));
      console.log("Attached custom policy");

      const { Role: NewRole } = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
      return NewRole.Arn;
    }
    throw e;
  }
}

async function buildDeploymentPackage() {
  console.log("Building deployment package...");
  
  const buildDir = join(__dirname, "build");
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  copyFileSync(join(__dirname, "index.mjs"), join(buildDir, "index.mjs"));
  copyFileSync(join(__dirname, "package.json"), join(buildDir, "package.json"));
  
  execSync("npm install --production", { cwd: buildDir, stdio: "inherit" });

  const zipPath = join(__dirname, "function.zip");
  
  // Use PowerShell Compress-Archive on Windows
  execSync(`powershell -Command "Compress-Archive -Path '${buildDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: "inherit" });
  
  console.log("Package created:", zipPath);
  return zipPath;
}

async function deployFunction(roleArn, zipPath) {
  console.log("Deploying Lambda function...");
  
  const zipBuffer = readFileSync(zipPath);
  
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    console.log("Function exists, updating code...");
    await lambda.send(new UpdateFunctionCodeCommand({
      FunctionName: FUNCTION_NAME,
      ZipFile: zipBuffer
    }));
  } catch (e) {
    if (e.name === "ResourceNotFoundException") {
      console.log("Creating new function...");
      await lambda.send(new CreateFunctionCommand({
        FunctionName: FUNCTION_NAME,
        Runtime: "nodejs20.x",
        Role: roleArn,
        Handler: "index.handler",
        Code: { ZipFile: zipBuffer },
        Timeout: 900,
        MemorySize: 1024,
        Environment: {
          Variables: {
            RDS_HOST: "ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com",
            RDS_PORT: "5432",
            RDS_DATABASE: "postgres",
            RDS_USER: "ucs_app",
            PG_DUMP_PATH: "/opt/pg_dump/bin/pg_dump",
            S3_BUCKET: "ucs-crm-backups",
            S3_PREFIX: "aws-rds",
            SECRET_NAME: "ucs-crm/rds-password"
          }
        },
        Tags: { Project: "UCS-CRM", Environment: "production" },
        Description: "pg_dump RDS to S3 backup for UCS CRM"
      }));
    } else throw e;
  }
  
  console.log("Function deployed");
}

async function createPgDumpLayer() {
  console.log("Creating pg_dump Lambda layer (placeholder)...");
  
  const layerDir = join(__dirname, "layer-placeholder");
  if (existsSync(layerDir)) rmSync(layerDir, { recursive: true, force: true });
  mkdirSync(join(layerDir, "bin"), { recursive: true });
  
  const placeholder = join(layerDir, "bin", "pg_dump");
  execSync(`echo '#!/bin/bash\necho "pg_dump placeholder - replace with real binary"' > "${placeholder}" && chmod +x "${placeholder}"`);
  
  const layerZip = join(__dirname, "layer-placeholder.zip");
  execSync(`cd "${layerDir}" && zip -r "${layerZip}" . -q`, { stdio: "inherit" });
  
  const { LayerVersionArn } = await lambda.send(new PublishLayerVersionCommand({
    LayerName: LAYER_NAME,
    Content: { ZipFile: readFileSync(layerZip) },
    CompatibleRuntimes: ["nodejs20.x"],
    Description: "pg_dump binary for PostgreSQL backups (placeholder - replace with real binary)"
  }));
  
  console.log("Layer created:", LayerVersionArn);
  return LayerVersionArn;
}

async function attachLayerToFunction(layerArn) {
  console.log("Attaching layer to function...");
  await lambda.send(new UpdateFunctionConfigurationCommand({
    FunctionName: FUNCTION_NAME,
    Layers: [layerArn]
  }));
  console.log("Layer attached");
}

async function main() {
  console.log("=== Deploying pg-dump Lambda ===\n");
  
  const roleArn = await getOrCreateExecutionRole();
  console.log("Role ARN:", roleArn);
  
  console.log("Waiting for role propagation...");
  await new Promise(r => setTimeout(r, 10000));
  
  const zipPath = await buildDeploymentPackage();
  await deployFunction(roleArn, zipPath);
  
  const layerArn = await createPgDumpLayer();
  await attachLayerToFunction(layerArn);
  
  console.log("\n=== Deployment Complete ===");
  console.log("Function:", FUNCTION_NAME);
  console.log("Layer:", LAYER_NAME);
  console.log("\nNext: Replace layer with real pg_dump binary");
  console.log("See: backend/scripts/backup/lambda-pg-dump/create-layer.mjs");
}

main().catch(e => { console.error(e); process.exit(1); });