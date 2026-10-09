import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';

/**
 * Runs migrations/151_chat.sql.
 *
 *   node scripts/verify-chat-migration.mjs                 # dry run, rolls back
 *   node scripts/verify-chat-migration.mjs --apply         # actually creates it
 *   node scripts/verify-chat-migration.mjs <connection-string>
 *
 * Postgres DDL is transactional, so the default dry run executes the real
 * migration and then ROLLBACKs. That validates the SQL - including the partial
 * unique index that ON CONFLICT infers against - without persisting anything.
 *
 * Connection string precedence: argv > CHAT_VERIFY_URL > TEST_DATABASE_URL.
 * CHAT_VERIFY_URL is the one to use through the SSH tunnel, e.g.
 *   $env:CHAT_VERIFY_URL = 'postgres://USER:PASS@localhost:5434/ucs_crm'
 */

dotenv.config();

const apply = process.argv.includes('--apply');
const argUrl = process.argv.find((a) => /^postgres(ql)?:\/\//.test(a));
const url = argUrl || process.env.CHAT_VERIFY_URL || process.env.TEST_DATABASE_URL;

if (!url) {
  console.error('No connection string. Pass one as an argument or set CHAT_VERIFY_URL.');
  process.exit(1);
}

const target = (() => {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, '') || '?'}`;
  } catch {
    return '(unparseable url)';
  }
})();
console.log(`target : ${target}`);
console.log(`mode   : ${apply ? 'APPLY (will persist)' : 'dry run (will ROLL BACK)'}`);
if (apply) {
  console.log('');
  console.log('  This writes to a real database. Ctrl-C now if that is not what you want.');
  console.log('');
}

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();
  await c.query('BEGIN');
  await c.query(fs.readFileSync('./migrations/151_chat.sql', 'utf8'));
  console.log('OK: migration SQL executed without error');

  const t = await c.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name LIKE 'chat_%' ORDER BY 1`
  );
  console.log('tables :', t.rows.map((r) => r.table_name).join(', ') || '(none)');

  const i = await c.query(
    `SELECT tablename, indexname FROM pg_indexes
     WHERE tablename LIKE 'chat_%' ORDER BY 1, 2`
  );
  for (const r of i.rows) console.log(`  index ${r.tablename}.${r.indexname}`);

  if (apply) {
    await c.query('COMMIT');
    console.log('\nCOMMIT - tables created');
  } else {
    await c.query('ROLLBACK');
    console.log('\nROLLBACK - nothing persisted');
  }
} catch (e) {
  console.error('\nFAILED:', e.message);
  try { await c.query('ROLLBACK'); } catch { /* already out of the transaction */ }
  process.exitCode = 1;
} finally {
  await c.end();
}
