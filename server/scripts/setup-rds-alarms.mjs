import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  CloudWatchClient,
  PutMetricAlarmCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
  ListSubscriptionsByTopicCommand,
} from "@aws-sdk/client-sns";
import { getRDSCapacity } from "../src/services/rdsCapacity.js";

// Loads backend/.env for RDS_DB_INSTANCE_IDENTIFIER / DATABASE_URL and the AWS
// credentials (same source as check_rds_load.mjs).
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

// ---------------------------------------------------------------------------
// RDS capacity alarms (burstable t3.micro host). Creates (or reuses) an SNS
// topic, subscribes alert emails, and creates CloudWatch alarms that fire when
// the micro instance starts running out of CPU credits, RAM, or headroom.
// Idempotent: alarm names are upserted, topic reuse + subscription dedup keep
// re-runs clean.
//
//   npx node scripts/setup-rds-alarms.mjs
//
// Env knobs:
//   DB_ALERT_EMAILS      comma-separated addresses to subscribe (default those
//                        used for backup alerts)
//   RDS_SNS_TOPIC_NAME   SNS topic name (default ucs-crm-db-alerts)
//   RDS_CPU_THRESHOLD    CPU % (default 70)
//   RDS_CREDIT_THRESHOLD CPUCreditBalance warning level (default 60)
//   RDS_MEM_MB_THRESHOLD Freeable memory warning level, MB (default 256)
//   RDS_CONN_THRESHOLD   DatabaseConnections warning level (default 90)
// ---------------------------------------------------------------------------

function resolveRdsTarget() {
  const hostMatch = (process.env.DATABASE_URL || "").match(
    /@([A-Za-z0-9-]+)\.([a-z]{2}(?:-[a-z]+)+-\d)\.rds\.amazonaws\.com/
  );
  const identifier = process.env.RDS_DB_INSTANCE_IDENTIFIER || (hostMatch && hostMatch[1]);
  const region = process.env.AWS_REGION || (hostMatch && hostMatch[2]) || "ap-south-1";
  if (!identifier) {
    throw new Error(
      "RDS_DB_INSTANCE_IDENTIFIER not set and DATABASE_URL host is not an RDS endpoint"
    );
  }
  return { identifier, region };
}

const { identifier, region } = resolveRdsTarget();
const SNS_TOPIC = process.env.RDS_SNS_TOPIC_NAME || "ucs-crm-db-alerts";
const EMAILS = (process.env.DB_ALERT_EMAILS || "admin@ufs.com,devops@ufs.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CPU_THRESHOLD = Number(process.env.RDS_CPU_THRESHOLD || 70);
const CREDIT_THRESHOLD = Number(process.env.RDS_CREDIT_THRESHOLD || 60);
const MEM_MB_THRESHOLD = Number(process.env.RDS_MEM_MB_THRESHOLD || 256);
const CONN_THRESHOLD = Number(process.env.RDS_CONN_THRESHOLD || 90);

const cw = new CloudWatchClient({ region });
const sns = new SNSClient({ region });

async function ensureTopic() {
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: SNS_TOPIC }));
  console.log("SNS topic ready:", TopicArn);
  return TopicArn;
}

async function subscribeEmails(topicArn) {
  if (EMAILS.length === 0) return;
  const { Subscriptions } = await sns.send(
    new ListSubscriptionsByTopicCommand({ TopicArn: topicArn })
  );
  const existing = new Set((Subscriptions || []).map((s) => s.Endpoint));
  for (const email of EMAILS) {
    if (existing.has(email)) {
      console.log(`already subscribed: ${email}`);
      continue;
    }
    await sns.send(
      new SubscribeCommand({ TopicArn: topicArn, Protocol: "email", Endpoint: email })
    );
    console.log(`subscribed: ${email} (confirm in inbox)`);
  }
}

async function putAlarm({ name, description, metric, statistic, period, evalPeriods, threshold, operator }) {
  await cw.send(
    new PutMetricAlarmCommand({
      AlarmName: `UCS-CRM-RDS-${name}`,
      AlarmDescription: description,
      Namespace: "AWS/RDS",
      MetricName: metric,
      Dimensions: [{ Name: "DBInstanceIdentifier", Value: identifier }],
      Statistic: statistic,
      Period: period,
      EvaluationPeriods: evalPeriods,
      Threshold: threshold,
      ComparisonOperator: operator,
      TreatMissingData: "notBreaching",
      AlarmActions: [SNS_ARN],
      OKActions: [SNS_ARN],
      Tags: [{ Key: "Project", Value: "UCS-CRM" }],
    })
  );
  console.log(`alarm created: ${name}`);
}

let SNS_ARN;

async function main() {
  console.log(`=== RDS capacity alarms for ${identifier} (${region}) ===\n`);

  SNS_ARN = await ensureTopic();
  await subscribeEmails(SNS_ARN);

  await putAlarm({
    name: "CPUUtilization",
    description: `RDS ${identifier} CPU above ${CPU_THRESHOLD}% for 10 min (t3 credit burn / heavy work)`,
    metric: "CPUUtilization",
    statistic: "Average",
    period: 300,
    evalPeriods: 2,
    threshold: CPU_THRESHOLD,
    operator: "GreaterThanThreshold",
  });

  await putAlarm({
    name: "CPUCreditBalance",
    description: `RDS ${identifier} burstable credits below ${CREDIT_THRESHOLD} — sustained heavy queries will soon degrade every request`,
    metric: "CPUCreditBalance",
    statistic: "Average",
    period: 300,
    evalPeriods: 1,
    threshold: CREDIT_THRESHOLD,
    operator: "LessThanThreshold",
  });

  await putAlarm({
    name: "FreeableMemory",
    description: `RDS ${identifier} free memory below ${MEM_MB_THRESHOLD} MB`,
    metric: "FreeableMemory",
    statistic: "Average",
    period: 300,
    evalPeriods: 1,
    threshold: MEM_MB_THRESHOLD * 1024 * 1024, // bytes
    operator: "LessThanThreshold",
  });

  await putAlarm({
    name: "DatabaseConnections",
    description: `RDS ${identifier} connection count above ${CONN_THRESHOLD}`,
    metric: "DatabaseConnections",
    statistic: "Average",
    period: 300,
    evalPeriods: 1,
    threshold: CONN_THRESHOLD,
    operator: "GreaterThanThreshold",
  });

  console.log("\nCurrent RDS capacity snapshot:");
  const cap = await getRDSCapacity();
  console.log(JSON.stringify(cap, null, 2));

  console.log("\n=== done ===");
  console.log("Next: confirm the email subscriptions, then re-check CPUCreditBalance");
  console.log("during a busy window with: node scripts/check_rds_load.mjs");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});