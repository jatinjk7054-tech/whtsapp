import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { RDS } from '@aws-sdk/client-rds';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const region = process.env.AWS_REGION || 'ap-south-1';
console.log('Using region:', region, '| creds source:', process.env.AWS_ACCESS_KEY_ID ? 'env' : 'instance');
const c = new RDS({ region });

async function run(name, fn) {
  try {
    const r = await fn();
    console.log(`[OK] ${name}:`, JSON.stringify(r));
  } catch (e) {
    console.log(`[FAIL] ${name}:`, e.name, '|', e.message);
  }
}

await run('describeDBInstances', () =>
  c.describeDBInstances().then((r) => r.DBInstances.map((d) => ({ id: d.DBInstanceIdentifier, status: d.DBInstanceStatus, arn: d.DBInstanceArn })))
);
await run('describeDBSnapshots', () =>
  c.describeDBSnapshots().then((r) => (r.DBSnapshots || []).map((s) => ({ id: s.DBSnapshotIdentifier, status: s.Status })))
);
await run('createDBSnapshot', () =>
  c.createDBSnapshot({ DBSnapshotIdentifier: 'ucs-test-snap-1', DBInstanceIdentifier: 'ucs-crm-db' }).then((r) => ({ id: r.DBSnapshot.DBSnapshotIdentifier, status: r.DBSnapshot.Status }))
);
await run('restoreDBInstanceFromDBSnapshot', () =>
  c.restoreDBInstanceFromDBSnapshot({
    DBInstanceIdentifier: 'ucs-crm-db-test',
    DBSnapshotIdentifier: 'ucs-test-snap-1',
    DBInstanceClass: 'db.t3.micro',
    Port: 5432,
    PubliclyAccessible: false,
  }).then((r) => ({ id: r.DBInstance.DBInstanceIdentifier, status: r.DBInstance.DBInstanceStatus }))
);
