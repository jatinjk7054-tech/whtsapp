// Removes every security group rule that backend/src/middleware/localDbAccess.js
// created. Run this by hand when a rule was left behind by a hard kill, a crash,
// or a laptop that was closed without stopping the server normally.
//
//   node scripts/revoke-local-db-access.mjs
//
// Only rules tagged with the tool's marker are touched, so any rule you added by
// hand in the AWS console is left alone.

import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { RULE_TAG, revokeAllLocalDbAccess } = await import('../src/middleware/localDbAccess.js');

console.log(`Looking for ${RULE_TAG}* rules to close...`);

try {
  const result = await revokeAllLocalDbAccess();
  if (!result.ok) {
    console.error(`Finished with errors: ${result.reason || ''}`);
    if (result.failed && result.failed.length) {
      for (const f of result.failed) console.error(`  ${f.cidr}: ${f.reason}`);
    }
    process.exit(1);
  }
  if (result.message) {
    console.log(result.message);
  } else {
    console.log(`Closed ${result.removed.length} rule(s) on ${result.groupId}: ${result.removed.join(', ') || 'none'}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  console.error('Check that AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are set and allow ec2:RevokeSecurityGroupIngress.');
  process.exit(1);
}
