import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

import pkgEc2 from '@aws-sdk/client-ec2';
import pkgRds from '@aws-sdk/client-rds';
const { EC2Client, AuthorizeSecurityGroupIngressCommand } = pkgEc2;
const { RDSClient, DescribeDBInstancesCommand } = pkgRds;

const ip = (await (await fetch('https://checkip.amazonaws.com')).text()).trim();
console.log('My public IP:', ip);

const region = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const rds = new RDSClient({ region });
const desc = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: 'ucs-crm-db' }));
const instance = desc.DBInstances[0];
if (!instance) { console.error('RDS instance not found'); process.exit(1); }
console.log('DB:', instance.DBInstanceIdentifier, '| Public:', instance.PubliclyAccessible);
const sg = instance.VpcSecurityGroups[0];
console.log('SG:', sg.VpcSecurityGroupId);
await rds.destroy();

const ec2 = new EC2Client({ region });
const cidr = `${ip}/32`;
try {
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: sg.VpcSecurityGroupId,
    IpPermissions: [{
      IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432,
      IpRanges: [{ CidrIp: cidr, Description: 'temp: agent-name fix' }],
    }],
  }));
  console.log(`Authorized ${cidr} on 5432`);
} catch (e) {
  if (/duplicate/i.test(String(e.message))) console.log('Rule already exists');
  else throw e;
}
