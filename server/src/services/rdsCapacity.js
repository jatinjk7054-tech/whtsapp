import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';

// ---------------------------------------------------------------------------
// Amazon RDS capacity metrics (dev tool).
// Requires AWS credentials (env, shared config, or instance role) plus either
// RDS_DB_INSTANCE_IDENTIFIER or a DATABASE_URL pointing at an *.rds.amazonaws.com
// host. Region is taken from AWS_REGION or inferred from the RDS endpoint host.
// ---------------------------------------------------------------------------

function parseRdsHost(connectionString) {
  try {
    const host = new URL(connectionString.replace(/^postgres:\/\//, 'postgres://')).hostname;
    const parts = host.split('.');
    const n = parts.length;
    if (n < 4 || parts[n - 1] !== 'com' || parts[n - 2] !== 'amazonaws' || parts[n - 3] !== 'rds') return null;
    const identifier = parts[0];
    const region = parts[n - 4];
    return { identifier, region: /^[a-z]{2}(-[a-z]+)+-\d$/.test(region) ? region : null };
  } catch {
    return null;
  }
}

function buildClients() {
  const host = parseRdsHost(process.env.DATABASE_URL || '');
  const identifier = process.env.RDS_DB_INSTANCE_IDENTIFIER || (host && host.identifier);
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || (host && host.region) || 'us-east-1';
  if (!identifier) {
    return { error: 'RDS_DB_INSTANCE_IDENTIFIER not set and DATABASE_URL host is not an RDS endpoint' };
  }
  const config = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  const rds = new RDSClient(config);
  const cloudwatch = new CloudWatchClient(config);
  return { identifier, rds, cloudwatch };
}

async function describeInstance(rds, identifier) {
  const { DBInstances } = await rds.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })
  );
  const i = DBInstances && DBInstances[0];
  if (!i) return null;
  return {
    identifier: i.DBInstanceIdentifier,
    class: i.DBInstanceClass,
    engine: i.Engine,
    engineVersion: i.EngineVersion,
    status: i.DBInstanceStatus,
    storageType: i.StorageType,
    allocatedStorageGB: i.AllocatedStorage,
    maxStorageGB: i.MaxAllocatedStorage,
    storageThroughput: i.StorageThroughput,
    multiAZ: i.MultiAZ,
    instanceCreateTime: i.InstanceCreateTime,
    endpoint: i.Endpoint && i.Endpoint.Address,
  };
}

async function getMetric(cloudwatch, identifier, metricName, statistics) {
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60 * 1000);
  const cmd = new GetMetricStatisticsCommand({
    Namespace: 'AWS/RDS',
    MetricName: metricName,
    Dimensions: [{ Name: 'DBInstanceIdentifier', Value: identifier }],
    StartTime: start,
    EndTime: now,
    Period: 300,
    Statistics: statistics,
  });
  const r = await cloudwatch.send(cmd);
  const points = (r.Datapoints || []).sort((a, b) => a.Timestamp - b.Timestamp);
  const pick = (k) => points.length ? points[points.length - 1][k] : null;
  const sum = points.reduce((acc, p) => acc + (p.Sum || 0), 0);
  return {
    samples: points.length,
    average: pick('Average'),
    maximum: pick('Maximum'),
    minimum: pick('Minimum'),
    sum,
    unit: r.Label,
  };
}

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

export async function getRDSCapacity() {
  const { error, identifier, rds, cloudwatch } = buildClients();
  if (error) return { ok: false, configured: false, reason: error };

  try {
    const instance = await describeInstance(rds, identifier);
    if (!instance) {
      return { ok: false, configured: true, reason: `No RDS instance "${identifier}" found` };
    }

    const [cpu, freeMemory, freeStorage, connections, readThroughput, writeThroughput, readLatency, writeLatency] =
      await Promise.all([
        getMetric(cloudwatch, identifier, 'CPUUtilization', ['Average', 'Maximum', 'Minimum']),
        getMetric(cloudwatch, identifier, 'FreeableMemory', ['Average', 'Maximum', 'Minimum']),
        getMetric(cloudwatch, identifier, 'FreeStorageSpace', ['Average', 'Minimum']),
        getMetric(cloudwatch, identifier, 'DatabaseConnections', ['Sum', 'Maximum']),
        getMetric(cloudwatch, identifier, 'ReadThroughput', ['Average', 'Maximum']),
        getMetric(cloudwatch, identifier, 'WriteThroughput', ['Average', 'Maximum']),
        getMetric(cloudwatch, identifier, 'ReadLatency', ['Average', 'Maximum']),
        getMetric(cloudwatch, identifier, 'WriteLatency', ['Average', 'Maximum']),
      ]);

    const allocatedGB = instance.allocatedStorageGB || 0;
    const freeGB = freeStorage.average != null ? freeStorage.average / GB : null;
    const usedGB = freeGB != null ? allocatedGB - freeGB : null;

    return {
      ok: true,
      configured: true,
      instance,
      sampledAt: new Date().toISOString(),
      metrics: {
        cpu,
        freeableMemory: {
          ...freeMemory,
          averageMB: freeMemory.average != null ? freeMemory.average / MB : null,
          maximumMB: freeMemory.maximum != null ? freeMemory.maximum / MB : null,
        },
        freeStorage: {
          ...freeStorage,
          freeGB,
          allocatedGB,
          usedGB,
          pctUsed: freeGB != null && allocatedGB > 0 ? ((usedGB / allocatedGB) * 100) : null,
        },
        connections,
        readThroughput: {
          ...readThroughput,
          averageKBS: readThroughput.average != null ? readThroughput.average / 1024 : null,
        },
        writeThroughput: {
          ...writeThroughput,
          averageKBS: writeThroughput.average != null ? writeThroughput.average / 1024 : null,
        },
        readLatency,
        writeLatency,
      },
    };
  } catch (err) {
    return { ok: false, configured: true, reason: err.message };
  }
}
