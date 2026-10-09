import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');
// Module 5: applied after schema.sql because contact_tags references contacts.
const tagsSchemaPath = path.join(here, 'tags.schema.sql');
// Module 6: away-message settings + quick replies (references staff).
const settingsSchemaPath = path.join(here, 'settings.schema.sql');
// Module 7: status = resolved + the status history table.
const statusSchemaPath = path.join(here, 'status.schema.sql');
// Module 8: analytics-friendly indexes (idempotent).
const analyticsSchemaPath = path.join(here, 'analytics.schema.sql');
// Module 9: automation settings, keyword rules, cooldown state and logs.
const automationSchemaPath = path.join(here, 'automation.schema.sql');

const reset = process.argv.includes('--reset');

// A dedicated pool, so running migrations never tears down the connection pool
// the API is using.
const pool = new pg.Pool({ ...config.db, max: 2 });

async function ensureDatabaseExists() {
  const admin = new pg.Client({ ...config.db, database: 'postgres' });

  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    config.db.database,
  ]);

  if (rowCount === 0) {
    await admin.query(`CREATE DATABASE "${config.db.database}"`);
    console.log(`Created database "${config.db.database}"`);
  }

  await admin.end();
}

async function migrate() {
  const sql = await readFile(schemaPath, 'utf8');
  const tagsSql = await readFile(tagsSchemaPath, 'utf8');
  const settingsSql = await readFile(settingsSchemaPath, 'utf8');
  const statusSql = await readFile(statusSchemaPath, 'utf8');
  const analyticsSql = await readFile(analyticsSchemaPath, 'utf8');
  const automationSql = await readFile(automationSchemaPath, 'utf8');

  if (reset) {
    await pool.query(
      'DROP TABLE IF EXISTS webhook_events, automation_logs, automation_rule_state, automation_rules, automation_settings, messages, conversation_status_history, conversations, contact_tags, tags, quick_replies, away_message_settings, contacts, staff, tasks CASCADE'
    );
    console.log('Dropped existing tables');
  }

  await pool.query(sql);
  await pool.query(tagsSql);
  await pool.query(settingsSql);
  await pool.query(statusSql);
  await pool.query(analyticsSql);
  await pool.query(automationSql);
  console.log('Migrations applied');
}

try {
  await ensureDatabaseExists();
  await migrate();
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}