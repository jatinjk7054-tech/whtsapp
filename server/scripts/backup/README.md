# UCS CRM Backup Scripts

## Directory Structure

```
scripts/backup/
├── create-backup-plan.mjs      # Main setup script - creates AWS Backup vault, plan, S3 bucket
├── setup-monitoring.mjs        # CloudWatch alarms, SNS, EventBridge rules
├── restore-test.mjs            # Restore test script (AWS Backup + S3 dump)
├── lambda-pg-dump/
│   ├── index.mjs               # Lambda handler (pg_dump to S3)
│   ├── package.json
│   └── layer/                  # pg_dump binary layer (build separately)
└── README.md                   # This file
```

---

## Quick Start

### Prerequisites

```bash
# AWS CLI configured with appropriate permissions
aws configure

# Set RDS password (required for create-backup-plan.mjs)
export RDS_PASSWORD="your-rds-password"
```

### 1. Create Backup Infrastructure

```bash
cd backend/scripts/backup
node create-backup-plan.mjs
```

This creates:
- AWS Backup Vault (`ucs-crm-backup-vault`)
- Backup Plan (`ucs-crm-rds-backup-plan`) with 2-day schedule + monthly retention
- Backup Selection (attaches to `ucs-crm-db` RDS instance)
- S3 Bucket (`ucs-crm-backups`) with encryption, versioning, lifecycle
- Secrets Manager secret for RDS password
- CloudWatch log group for Lambda

### 2. Deploy Lambda pg-dump Function

```bash
cd lambda-pg-dump
npm install
# Build Lambda layer with pg_dump binary (see layer/README.md)
zip -r ../backup-pg-dump.zip .
# Deploy via AWS Console or CLI
```

### 3. Setup Monitoring & Alerting

```bash
node setup-monitoring.mjs
```

Creates:
- SNS topic (`ucs-crm-backup-alerts`) with email subscriptions
- CloudWatch alarms (backup failed, delayed, Lambda errors, bucket size)
- EventBridge rules (backup state changes, Lambda failures)
- Scheduled EventBridge rule for Lambda (every 2 days at 02:00 UTC)

### 4. Test Restore

```bash
# Test AWS Backup restore
node restore-test.mjs aws-backup

# Test S3 dump restore
node restore-test.mjs s3-dump
```

---

## Required IAM Permissions

The scripts require an IAM role/user with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "backup:CreateBackupVault",
        "backup:CreateBackupPlan",
        "backup:CreateBackupSelection",
        "backup:ListRecoveryPointsByBackupVault",
        "backup:StartRestoreJob",
        "backup:DescribeRestoreJob"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketEncryption",
        "s3:PutPublicAccessBlock",
        "s3:PutBucketVersioning",
        "s3:PutBucketLifecycleConfiguration",
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::ucs-crm-backups",
        "arn:aws:s3:::ucs-crm-backups/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:ap-south-1:*:secret:ucs-crm/rds-password*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DeleteDBInstance"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sns:CreateTopic",
        "sns:Subscribe",
        "sns:Publish"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricAlarm"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "events:PutRule",
        "events:PutTargets"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:AddPermission"
      ],
      "Resource": "arn:aws:lambda:ap-south-1:*:function:ucs-crm-backup-pg-dump"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::*:role/aws-service-role/backup.amazonaws.com/AWSServiceRoleForBackup"
    }
  ]
}
```

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `RDS_PASSWORD` | RDS master user password | Yes (for setup) |
| `AWS_REGION` | AWS region | Default: ap-south-1 |
| `AWS_PROFILE` | AWS CLI profile | Optional |

---

## Backup Schedule Summary

| Component | Schedule | Retention |
|-----------|----------|-----------|
| AWS Backup (Standard) | Every 2 days, 02:00 UTC | 28 days |
| AWS Backup (Monthly) | 1st of month, 03:00 UTC | 365 days |
| Lambda pg_dump (S3) | Every 2 days, 02:00 UTC | 365 days (S3 lifecycle) |
| Monthly S3 Dump | 1st of month | 7 years (Glacier Deep Archive) |

---

## Restore Procedures

### AWS Backup Console (Preferred)
1. AWS Console → AWS Backup → Backup vaults → `ucs-crm-backup-vault`
2. Select recovery point → Restore → **Create new database**
3. Verify → Update DNS → Decommission old instance

### S3 Dump Restore
```bash
# Download
aws s3 cp s3://ucs-crm-backups/aws-rds/2026/08/2026-08-19/ucs-crm-db-2026-08-19.sql.gz .

# Decompress & restore
gunzip ucs-crm-db-2026-08-19.sql.gz
psql -h <target-endpoint> -U ucs_admin -d postgres < ucs-crm-db-2026-08-19.sql
```

---

## Monthly Restore Test

Run on 1st business day of each month:

```bash
# Test AWS Backup restore
node restore-test.mjs aws-backup

# Test S3 dump restore
node restore-test.mjs s3-dump
```

Document results in `RESTORE_TEST_LOG.md`.

---

## Future: Local Server Integration

When local server is deployed, add:

1. IAM User `ucs-crm-local-backup` with policy:
   ```json
   {
     "Effect": "Allow",
     "Action": ["s3:PutObject"],
     "Resource": "arn:aws:s3:::ucs-crm-backups/local-server/*"
   }
   ```

2. Deploy `scripts/local-backup/local-backup.sh` to local server
3. Add cron: `0 2 */2 * * /opt/ucs-crm/scripts/local-backup/local-backup.sh`

S3 structure supports both sources:
```
s3://ucs-crm-backups/
├── aws-rds/        ← Current production backups
└── local-server/   ← Future local server backups
```

---

## Cost Optimization

- AWS Backup: ~$5-15/month (500 GB)
- S3 Standard: ~$1-2/month
- S3 Glacier/Deep Archive: ~$0.50-1/month
- Lambda: ~$0.10/month
- CloudWatch: ~$1-2/month
- **Total: ~$8-20/month**

---

## Security Checklist

- [ ] S3 Block Public Access: ALL ON
- [ ] S3 Default Encryption: AES-256
- [ ] S3 Versioning: Enabled
- [ ] S3 MFA Delete: Enabled
- [ ] AWS Backup Encryption: KMS (AES-256)
- [ ] RDS Password in Secrets Manager (not env vars)
- [ ] Lambda in Private VPC (no internet access)
- [ ] Lambda SG: Only RDS (5432) + S3 outbound
- [ ] CloudTrail: Enabled for Backup, S3, RDS
- [ ] Backup Vault Lock: Consider (7-day minimum)
- [ ] IAM Least Privilege: Separate creator/deleter roles