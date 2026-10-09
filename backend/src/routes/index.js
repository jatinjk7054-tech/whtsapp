import { Router } from 'express';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { whenIngestIdle } from '../conversations/inbound.service.js';
import { taskRouter } from '../tasks/task.routes.js';
import { staffRouter } from '../staff/staff.routes.js';
import { conversationRouter } from '../conversations/conversation.routes.js';
import { mediaRouter } from '../media/media.routes.js';
import { contactRouter } from '../contacts/contact.routes.js';
import { tagRouter } from '../tags/tag.routes.js';
import { awaySettingsRouter } from '../away/away.routes.js';
import { quickReplyRouter } from '../quickreplies/quick-reply.routes.js';
import { whatsappRouter } from '../whatsapp.routes.js';
import { agentPerformanceRouter } from '../analytics/agent-performance.routes.js';
import { automationRouter } from '../automation/automation.routes.js';
import { reminderRouter } from '../reminders/reminder.routes.js';
import { notificationRouter } from '../notifications/notification.routes.js';
import { callRouter } from '../calls/call.routes.js';

export const apiRouter = Router();

apiRouter.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({
      status: 'ok',
      database: 'up',
      env: config.env,
      whatsapp: config.whatsapp.enabled ? 'configured' : 'not_configured',
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      database: 'down',
      message: 'Cannot reach PostgreSQL. Is it running, and do the .env credentials match?',
    });
  }
});

/**
 * Lets an operator drain webhook processing before a deploy, instead of the
 * process being killed mid-ingest.
 */
apiRouter.post(
  '/admin/flush',
  authenticate,
  requireRole('admin'),
  async (_req, res, next) => {
    whenIngestIdle()
      .then(() => res.json({ status: 'idle' }))
      .catch(next);
  }
);

apiRouter.use('/tasks', taskRouter);
apiRouter.use('/staff', staffRouter);
apiRouter.use('/conversations', conversationRouter);
apiRouter.use('/media', mediaRouter);
apiRouter.use('/contacts', contactRouter);
apiRouter.use('/tags', tagRouter);
apiRouter.use('/settings/away-message', awaySettingsRouter);
apiRouter.use('/quick-replies', quickReplyRouter);
apiRouter.use('/whatsapp', whatsappRouter);
apiRouter.use('/admin/agent-performance', agentPerformanceRouter);
apiRouter.use('/automation', automationRouter);
apiRouter.use('/reminders', reminderRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/calls', callRouter);