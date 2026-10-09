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
import { ensureRemindersSchema } from './reminders/reminder.repository.js';
import { ensureNotificationsSchema } from './notifications/notification.repository.js';
import {
  ensureMessageStatusSchema,
  reconcileStatusEvents,
} from './conversations/message.repository.js';
import { ensureCallsSchema } from './calls/call.repository.js';
import { sweepStaleCalls } from './calls/call.service.js';
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

  try {
    // Module 10: follow-up reminders + the per-staff notification feed —
    // idempotent, so an existing install gains Module 10 with no manual step.
    await ensureRemindersSchema();
    await ensureNotificationsSchema();
  } catch (error) {
    console.error('Reminder schema upgrade failed (run `npm run migrate`):', error.message);
  }

  try {
    // Module 11: delivery/read receipt columns + the status-event log —
    // idempotent, so an existing install gains Module 11 with no manual step.
    await ensureMessageStatusSchema();
  } catch (error) {
    console.error('Message-status schema upgrade failed (run `npm run migrate`):', error.message);
  }

  try {
    // Module 12: voice calls + the call event log — idempotent, so an existing
    // install gains calling with no manual migration step.
    await ensureCallsSchema();
  } catch (error) {
    console.error('Calling schema upgrade failed (run `npm run migrate`):', error.message);
  }

  // Module 11: safety net for status events that raced their message row.
  // unref() so the timer never keeps the process alive on shutdown.
  setInterval(() => {
    reconcileStatusEvents({ limit: 100 }).catch((error) =>
      console.error('Status reconciliation failed:', error.message)
    );
  }, 30_000).unref();

  // Module 12: never leave a call stuck in-flight after a lost webhook or a
  // browser that vanished mid-call.
  setInterval(() => {
    sweepStaleCalls().catch((error) =>
      console.error('Stale-call sweep failed:', error.message)
    );
  }, 60_000).unref();
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