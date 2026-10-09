// ---------------------------------------------------------------------------
// One-off S3 setup: creates the S3_BUCKET (if missing) and applies a public-read
// bucket policy + permissive CORS so files stored via the db.js storage() shim
// are publicly fetchable at https://<bucket>.s3.<region>.amazonaws.com/...
//
// Usage:  node scripts/setup-s3.js
// Requires: S3_BUCKET (+ AWS creds from env / shared config). The IAM user
// needs s3:CreateBucket, s3:PutBucketPolicy, s3:PutBucketCors.
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const bucket = process.env.S3_BUCKET;
const region = process.env.S3_REGION || process.env.AWS_REGION || 'ap-northeast-2';

if (!bucket) {
  console.error('S3_BUCKET is not set in backend/.env');
  process.exit(1);
}

const client = new S3Client({ region });

async function headBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function createBucket() {
  await client.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}),
  }));
}

async function applyPolicy() {
  await client.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      }],
    }),
  }));
}

async function applyCors() {
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ['*'],
        AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
        AllowedHeaders: ['*'],
        MaxAgeSeconds: 3000,
      }],
    },
  }));
}

const exists = await headBucket();
if (exists) {
  console.log(`Bucket "${bucket}" already exists.`);
} else {
  console.log(`Bucket "${bucket}" does not exist — creating in ${region}...`);
  try {
    await createBucket();
    console.log('Bucket created.');
  } catch (e) {
    console.error('Failed to create bucket:', e.message);
    console.error('The IAM user needs s3:CreateBucket. Attach AmazonS3FullAccess (or a scoped policy) to it in the AWS console.');
    process.exit(1);
  }
}

try {
  await applyPolicy();
  console.log('Public-read policy applied.');
} catch (e) {
  console.warn('Policy apply failed (needs s3:PutBucketPolicy):', e.message);
}

try {
  await applyCors();
  console.log('CORS applied.');
} catch (e) {
  console.warn('CORS apply failed (optional, needs s3:PutBucketCors):', e.message);
}

console.log(`Public URL base: https://${bucket}.s3.${region}.amazonaws.com`);
