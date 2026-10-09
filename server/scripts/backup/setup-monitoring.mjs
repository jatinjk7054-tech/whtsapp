import { CloudWatchClient, PutMetricAlarmCommand } from "@aws-sdk/client-cloudwatch";
import { SNSClient, CreateTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { EventsClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { LambdaClient, AddPermissionCommand } from "@aws-sdk/client-lambda";

const REGION = "ap-south-1";
const ACCOUNT_ID = "938364502045";
const LAMBDA_FUNCTION = "ucs-crm-backup-pg-dump";
const SNS_TOPIC = "ucs-crm-backup-alerts";
const EMAIL_PRIMARY = "admin@ufs.com";
const EMAIL_SECONDARY = "devops@ufs.com";

const cw = new CloudWatchClient({ region: REGION });
const sns = new SNSClient({ region: REGION });
const events = new EventsClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

async function createSnsTopic() {
  console.log("Creating SNS topic...");
  const { TopicArn } = await sns.send(new CreateTopicCommand({
    Name: SNS_TOPIC,
    Tags: [{ Key: "Project", Value: "UCS-CRM" }, { Key: "Environment", Value: "production" }]
  }));
  console.log("✓ SNS topic created:", TopicArn);
  return TopicArn;
}

async function subscribeEmails(topicArn) {
  console.log("Subscribing email addresses...");
  for (const email of [EMAIL_PRIMARY, EMAIL_SECONDARY]) {
    await sns.send(new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: "email",
      Endpoint: email
    }));
    console.log(`✓ Subscribed: ${email} (check email for confirmation)`);
  }
}

async function createBackupFailedAlarm(topicArn) {
  console.log("Creating CloudWatch alarm: Backup Job Failed...");
  await cw.send(new PutMetricAlarmCommand({
    AlarmName: "UCS-CRM-Backup-Job-Failed",
    AlarmDescription: "AWS Backup job failed for UCS CRM RDS",
    Namespace: "AWS/Backup",
    MetricName: "NumberOfBackupJobsFailed",
    Dimensions: [{ Name: "BackupVaultName", Value: "ucs-crm-backup-vault" }],
    Statistic: "Sum",
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [topicArn],
    OKActions: [topicArn],
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ Alarm created: Backup Job Failed");
}

async function createBackupDelayedAlarm(topicArn) {
  console.log("Creating CloudWatch alarm: Backup Job Delayed...");
  await cw.send(new PutMetricAlarmCommand({
    AlarmName: "UCS-CRM-Backup-Job-Delayed",
    AlarmDescription: "AWS Backup job taking too long (>30 min)",
    Namespace: "AWS/Backup",
    MetricName: "BackupJobDuration",
    Dimensions: [{ Name: "BackupVaultName", Value: "ucs-crm-backup-vault" }],
    Statistic: "Maximum",
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 1800,
    ComparisonOperator: "GreaterThanThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [topicArn],
    OKActions: [topicArn],
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ Alarm created: Backup Job Delayed");
}

async function createLambdaErrorsAlarm(topicArn) {
  console.log("Creating CloudWatch alarm: Lambda Errors...");
  await cw.send(new PutMetricAlarmCommand({
    AlarmName: "UCS-CRM-Lambda-Errors",
    AlarmDescription: "Lambda pg-dump function errors",
    Namespace: "AWS/Lambda",
    MetricName: "Errors",
    Dimensions: [{ Name: "FunctionName", Value: "ucs-crm-backup-pg-dump" }],
    Statistic: "Sum",
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [topicArn],
    OKActions: [topicArn],
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ Alarm created: Lambda Errors");
}

async function createBucketSizeAlarm(topicArn) {
  console.log("Creating CloudWatch alarm: Backup Bucket Size...");
  await cw.send(new PutMetricAlarmCommand({
    AlarmName: "UCS-CRM-Backup-Bucket-Size",
    AlarmDescription: "S3 backup bucket size exceeded threshold",
    Namespace: "AWS/S3",
    MetricName: "BucketSizeBytes",
    Dimensions: [
      { Name: "BucketName", Value: "ucs-crm-backups" },
      { Name: "StorageType", Value: "StandardStorage" }
    ],
    Statistic: "Average",
    Period: 86400,
    EvaluationPeriods: 1,
    Threshold: 107374182400, // 100 GB
    ComparisonOperator: "GreaterThanThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [topicArn],
    OKActions: [topicArn],
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ Alarm created: Backup Bucket Size");
}

async function createEventBridgeRules() {
  console.log("Creating EventBridge rules...");

  // Backup Job State Change
  await events.send(new PutRuleCommand({
    Name: "UCS-CRM-BackupJobStateChange",
    Description: "Trigger on AWS Backup job state changes",
    EventPattern: JSON.stringify({
      source: ["aws.backup"],
      "detail-type": ["Backup Job State Change"],
      detail: {
        state: ["COMPLETED", "FAILED", "PARTIAL"]
      }
    }),
    State: "ENABLED",
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ EventBridge rule: Backup Job State Change");

  // Lambda Failure
  await events.send(new PutRuleCommand({
    Name: "UCS-CRM-LambdaFailure",
    Description: "Trigger on Lambda function failure",
    EventPattern: JSON.stringify({
      source: ["aws.lambda"],
      "detail-type": ["Lambda Function Invocation Result - Failure"],
      detail: {
        functionName: ["ucs-crm-backup-pg-dump"]
      }
    }),
    State: "ENABLED",
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ EventBridge rule: Lambda Failure");
}

async function addLambdaPermission() {
  console.log("Adding EventBridge permission to invoke Lambda...");
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: "ucs-crm-backup-pg-dump",
      StatementId: "EventBridgeInvoke",
      Action: "lambda:InvokeFunction",
      Principal: "events.amazonaws.com",
      SourceArn: `arn:aws:events:ap-south-1:${ACCOUNT_ID}:rule/UCS-CRM-ScheduledBackup`
    });
    console.log("✓ Lambda permission added for EventBridge");
  } catch (e) {
    if (e.name === "ResourceConflictException") {
      console.log("✓ Lambda permission already exists");
    } else throw e;
  }
}

async function createScheduledRule() {
  console.log("Creating EventBridge scheduled rule for Lambda (every 2 days)...");
  await events.send(new PutRuleCommand({
    Name: "UCS-CRM-ScheduledBackup",
    Description: "Trigger pg-dump Lambda every 2 days at 02:00 UTC",
    ScheduleExpression: "cron(0 2 */2 * ? *)",
    State: "ENABLED",
    Tags: [{ Key: "Project", Value: "UCS-CRM" }]
  }));
  console.log("✓ EventBridge scheduled rule created");

  // Add Lambda as target
  await events.send(new PutTargetsCommand({
    Rule: "UCS-CRM-ScheduledBackup",
    Targets: [{
      Id: "1",
      Arn: `arn:aws:lambda:ap-south-1:${ACCOUNT_ID}:function:ucs-crm-backup-pg-dump`
    }]
  }));
  console.log("✓ Lambda added as target");
}

async function main() {
  console.log("=== Setting up Monitoring & Alerting ===\n");

  const topicArn = await createSnsTopic();
  await subscribeEmails(topicArn);
  await createBackupFailedAlarm(topicArn);
  await createBackupDelayedAlarm(topicArn);
  await createLambdaErrorsAlarm(topicArn);
  await createBucketSizeAlarm(topicArn);
  await createEventBridgeRules();
  await createScheduledRule();
  await addLambdaPermission();

  console.log("\n=== Monitoring Setup Complete ===");
  console.log("SNS Topic:", topicArn);
  console.log("\nNext steps:");
  console.log("1. Confirm email subscriptions (check inbox)");
  console.log("2. Deploy Lambda function (see lambda-pg-dump/)");
  console.log("3. Test alarms by triggering backup manually");
}

main().catch(e => { console.error(e); process.exit(1); });