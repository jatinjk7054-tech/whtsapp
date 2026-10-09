import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';

/**
 * Applies migrations/151b_chat_seed.sql and prints the verification counts.
 *
 *   node scripts/seed-chat.mjs <connection-string>
 *
 * Idempotent - safe to re-run. Normally unnecessary: ensureChatSchema does this
 * on every backend boot.
 */

dotenv.config();

const argUrl = process.argv.find((a) => /^postgres(ql)?:\/\//.test(a));
const url = argUrl || process.env.CHAT_VERIFY_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('No connection string.');
  process.exit(1);
}

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await c.connect();
  await c.query(fs.readFileSync('./migrations/151b_chat_seed.sql', 'utf8'));
  console.log('OK: seed applied\n');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
