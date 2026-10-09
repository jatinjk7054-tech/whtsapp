import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  aiSettingsGet,
  aiSettingsPut,
  aiSuggestionsList,
  aiSuggestionDecide,
  aiPreview,
  broadcastCreate,
  broadcastList,
  broadcastGet,
  broadcastStart,
  broadcastPause,
  broadcastCancel,
  templatesSync,
  routingRulesList,
  routingRulesCreate,
  routingRulesUpdate,
  routingRulesDelete,
  analyticsOverview,
  analyticsDaily,
  analyticsAgents,
  analyticsBroadcasts,
} from '../controllers/whatsappEnhancementsController.js';

const router = Router();
const admin = authenticateRole('accounts', 'super_admin');

// AI auto-reply
router.get('/ai/settings/:project', admin, aiSettingsGet);
router.put('/ai/settings/:project', admin, aiSettingsPut);
router.get('/ai/suggestions', admin, aiSuggestionsList);
router.post('/ai/suggestions/:id/decide', admin, aiSuggestionDecide);
router.post('/ai/preview/:conversationId', admin, aiPreview);

// Broadcasts
router.post('/broadcasts', admin, broadcastCreate);
router.get('/broadcasts', admin, broadcastList);
router.get('/broadcasts/:id', admin, broadcastGet);
router.post('/broadcasts/:id/start', admin, broadcastStart);
router.post('/broadcasts/:id/pause', admin, broadcastPause);
router.post('/broadcasts/:id/cancel', admin, broadcastCancel);

// Template sync
router.post('/templates/sync', admin, templatesSync);

// Routing rules
router.get('/routing-rules', admin, routingRulesList);
router.post('/routing-rules', admin, routingRulesCreate);
router.put('/routing-rules/:id', admin, routingRulesUpdate);
router.delete('/routing-rules/:id', admin, routingRulesDelete);

// Analytics
router.get('/analytics/overview', admin, analyticsOverview);
router.get('/analytics/daily', admin, analyticsDaily);
router.get('/analytics/agents', admin, analyticsAgents);
router.get('/analytics/broadcasts', admin, analyticsBroadcasts);

export default router;
