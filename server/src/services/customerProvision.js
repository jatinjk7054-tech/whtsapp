import crypto from 'crypto';
import pg from 'pg';
import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import {
  IAMClient,
  CreateUserCommand,
  CreateAccessKeyCommand,
  PutUserPolicyCommand,
  ListAccessKeysCommand,
  paginateListUsers,
} from '@aws-sdk/client-iam';
import db from '../config/db.js';

// ---------------------------------------------------------------------------
// Customer provisioning: one-click setup of a dedicated Postgres database +
// S3 bucket + IAM user (with scoped bucket policy) + access keys.
// ---------------------------------------------------------------------------

const REGION = process.env.AWS_REGION || 'ap-south-1';
const BUCKET_PREFIX = (process.env.CUSTOMER_BUCKET_PREFIX || 'ucs').toLowerCase().replace(/[^a-z0-9-]/g, '');
const IAM_PREFIX = 'cust-';
const DB_PREFIX = 'cust_';

function awsConfig() {
  const config = { region: REGION };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  return config;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function randToken() {
  return crypto.randomBytes(15).toString('base64url');
}

function randHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

let _s3 = null;
function getS3() {
  if (!_s3) _s3 = new S3Client(awsConfig());
  return _s3;
}

let _iam = null;
function getIam() {
  if (!_iam) _iam = new IAMClient(awsConfig());
  return _iam;
}

// Connection used only for provisioning (needs CREATEDB).
function adminPool() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error('ADMIN_DATABASE_URL is not set in backend/.env. Add a connection string for a role with CREATEDB (e.g. ucs_admin).');
  }
  return new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false,
    max: 2,
  });
}

function bucketPolicy(bucket) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation', 's3:GetBucketVersioning'],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:GetObjectVersion', 's3:ListMultipartUploadParts'],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  });
}

export async function provisionCustomer(name) {
  const slug = slugify(name);
  if (!slug) throw new Error('Customer name must contain letters or numbers');

  const dbName = `${DB_PREFIX}${slug}`;
  const role = dbName;
  const bucket = `${BUCKET_PREFIX}-${slug}-${randHex(3)}`.toLowerCase();
  const iamUser = `${IAM_PREFIX}${slug}`;
  const dbPassword = randToken();

  const created = { database: dbName, bucket, iamUser };
  const steps = [];

  try {
    // ---- 1. Postgres database + role --------------------------------------
    const admin = adminPool();
    try {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" LOGIN PASSWORD '${dbPassword}'; END IF; END $$`);
      await admin.query(`ALTER ROLE "${role}" PASSWORD '${dbPassword}'`);
      // Creator must be a member of the role to CREATE DATABASE ... OWNER it.
      await admin.query(`GRANT "${role}" TO CURRENT_USER`);
      try {
        await admin.query(`CREATE DATABASE "${dbName}" OWNER "${role}"`);
      } catch (e) {
        if (!String(e.message).includes('already exists')) throw e;
      }
      await admin.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`);
      steps.push('database');
    } finally {
      await admin.end();
    }

    // ---- 2. S3 bucket (public access blocked) -----------------------------
    try {
      await getS3().send(new CreateBucketCommand({
        Bucket: bucket,
        ...(REGION !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: REGION } } : {}),
      }));
    } catch (e) {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e.message)) throw e;
    }
    await getS3().send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }));
    steps.push('bucket');

    // ---- 3. IAM user + scoped policy + access keys ------------------------
    try {
      await getIam().send(new CreateUserCommand({
        UserName: iamUser,
        Tags: [{ Key: 'managed', Value: 'ucs-crm-provision' }],
      }));
    } catch (e) {
      if (!/EntityAlreadyExists/.test(e.message)) throw e;
    }
    await getIam().send(new PutUserPolicyCommand({
      UserName: iamUser,
      PolicyName: `${iamUser}-bucket`,
      PolicyDocument: bucketPolicy(bucket),
    }));
    const existingKeys = await getIam().send(new ListAccessKeysCommand({ UserName: iamUser }));
    let AccessKey = existingKeys.AccessKeyMetadata && existingKeys.AccessKeyMetadata[0];
    if (!AccessKey) {
      ({ AccessKey } = await getIam().send(new CreateAccessKeyCommand({ UserName: iamUser })));
      created.accessKeyId = AccessKey.AccessKeyId;
      created.secretAccessKey = AccessKey.SecretAccessKey;
    }
    steps.push('iam');
  } catch (err) {
    const suffix = `${slug}-${randHex(2)}`;
    const message = err && err.message ? err.message : String(err);
    const detail =
      /AccessDenied|not authorized|UnauthorizedOperation/i.test(message)
        ? 'The AWS IAM user used by this backend is missing permissions. Add: s3:CreateBucket, s3:PutBucketPublicAccessBlock, iam:CreateUser, iam:PutUserPolicy, iam:CreateAccessKey.'
        : /permission denied for database/i.test(message)
          ? 'ADMIN_DATABASE_URL user needs CREATEDB privilege.'
          : '';
    throw new Error(`${message}${detail ? ` — ${detail}` : ''}`);
  }

  const host = new URL(process.env.DATABASE_URL).hostname;
  const port = new URL(process.env.DATABASE_URL).port || '5432';

  return {
    ok: true,
    customer: name,
    slug,
    steps,
    database: {
      name: dbName,
      user: role,
      password: dbPassword,
      host,
      port,
      ssl: true,
      connectionString: `postgresql://${role}:${encodeURIComponent(dbPassword)}@${host}:${port}/${dbName}`,
    },
    bucket: { name: bucket },
    iam: {
      user: iamUser,
      policyName: `${iamUser}-bucket`,
      accessKeyId: created.accessKeyId,
      secretAccessKey: created.secretAccessKey,
    },
  };
}

export async function listCustomers() {
  const out = { databases: [], buckets: [], users: [] };
  try {
    const pool = db._pool;
    const { rows } = await pool.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'cust_%' ORDER BY datname"
    );
    out.databases = rows.map((r) => r.datname);
  } catch (e) {
    out.databasesError = e && e.message ? e.message : String(e);
  }

  try {
    const { Buckets } = await getS3().send(new ListBucketsCommand({}));
    out.buckets = (Buckets || [])
      .map((b) => ({ name: b.Name, created: b.CreationDate ? b.CreationDate.toISOString() : null }))
      .filter((b) => b.name.startsWith(BUCKET_PREFIX + '-'))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch (e) {
    out.bucketsError = e && e.message ? e.message : String(e);
  }

  try {
    const users = [];
    const paginator = paginateListUsers({ client: getIam() }, { MaxItems: 1000 });
    for await (const page of paginator) {
      for (const u of page.Users || []) {
        if (u.UserName.startsWith(IAM_PREFIX)) users.push({ name: u.UserName, created: u.CreateDate ? u.CreateDate.toISOString() : null });
      }
    }
    out.users = users.sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch (e) {
    out.usersError = e && e.message ? e.message : String(e);
  }

  return out;
}
