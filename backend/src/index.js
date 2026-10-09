import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { seedAdminIfEmpty, seedExampleAgents } from './staff/staff.service.js';
import { seedTags } from './tags/tag.repository.js';
import { ensureAwaySettings } from './away/away.repository.js';
import { ensureQuickReplies } from './quickreplies/quick-reply.repository.js';
import { ensureStatusSchema } from './conversations/conversation.repository.js';
import { ensureAnalyticsSchema } from './analytics/agent-performance.repository.js';
import { ensureAutomationSchema } from './automation/automation.repository.js';
import { whenIngestIdle } from './conversations/inbound.service.js';

const app = createApp();

const server = app.listen(config.port, async () => {
  console.log(`API listening on http://localhost:${config.port} [${config.env}]`);
  console.log(
    config.whatsapp.enabled
      ? 'WhatsApp Cloud API configured'
      : 'WhatsApp Cloud API NOT configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN)'
  );

  try {
    await seedAdminIfEmpty();
    await seedExampleAgents();
  } catch (error) {
    console.error('Admin seed failed:', error.message);
  }

  try {
    // Module 5: tables + the five default tags, idempotent — running it on
    // every boot can never duplicate a tag or touch existing assignments.
    await seedTags();
  } catch (error) {
    console.error('Tag seed failed (run `npm run migrate`):', error.message);
  }

  try {
    // Module 6: away-message settings row + starter quick replies, both
    // idempotent, so upgrades get Module 6 without a manual migration step.
    await ensureAwaySettings();
    await ensureQuickReplies();
  } catch (error) {
    console.error('Settings seed failed (run `npm run migrate`):', error.message);
  }

  try {
    // Module 7: widen the status CHECK to include 'resolved' and create the
    // history table — idempotent, so an upgrade needs no manual migration.
    await ensureStatusSchema();
  } catch (error) {
    console.error('Status schema upgrade failed (run `npm run migrate`):', error.message);
  }

  try {
    // Module 8: analytics indexes — idempotent, upgrades need no manual step.
    await ensureAnalyticsSchema();
  } catch (error) {
    console.error('Analytics schema upgrade failed (run `npm run migrate`):', error.message);
  }

  try {
    // Module 9: automation settings, keyword rules, cooldown state and logs —
    // idempotent, so an existing install gains Module 9 with no manual step.
    await ensureAutomationSchema();
  } catch (error) {
    console.error('Automation schema upgrade failed (run `npm run migrate`):', error.message);
  }
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);

  server.close();

  // Let in-flight webhook writes finish before the pool goes away, otherwise a
  // customer message can be lost during a deploy.
  await whenIngestIdle();
  await pool.end();

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));