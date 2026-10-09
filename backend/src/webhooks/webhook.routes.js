import { Router } from 'express';
import { config } from '../config.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { verifyWebhookSignature } from '../middleware/webhookSignature.js';
import { ingestWebhookPayload } from '../conversations/inbound.service.js';
import { recordWabaId } from '../lib/whatsapp/client.js';

export const webhookRouter = Router();

webhookRouter.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || token !== config.whatsapp.verifyToken) {
    return res.status(403).json({ error: 'verification_failed' });
  }

  return res.status(200).send(String(challenge ?? ''));
});

webhookRouter.post(
  '/whatsapp',
  verifyWebhookSignature,
  asyncRoute(async (req, res) => {
    // `object: whatsapp_business_account` ke har webhook me entry.id WABA id
    // hota hai — template listing ke liye wahi chahiye aur Graph phone number
    // id se ise bata nahi sakta.
    if (req.body?.object === 'whatsapp_business_account') {
      for (const entry of req.body.entry ?? []) recordWabaId(entry.id);
    }

    console.log(
      'WHATSAPP WEBHOOK:',
      JSON.stringify({
        object: req.body?.object,
        entries: (req.body?.entry ?? []).map((entry) => ({
          entryId: entry.id,
          changes: (entry?.changes ?? []).map((change) => ({
            field: change?.field,
            hasMessages: Array.isArray(change?.value?.messages),
            messageCount: change?.value?.messages?.length ?? 0,
            statusCount: change?.value?.statuses?.length ?? 0,
            messageTypes: (change?.value?.messages ?? []).map((m) => m?.type),
            waIds: (change?.value?.messages ?? []).map((m) => m?.from),
            messageIds: (change?.value?.messages ?? []).map((m) => m?.id),
          })),
        })),
      })
    );

    res.status(200).json({ received: true });

    ingestWebhookPayload(req.body)
      .then((summary) => {
        console.log('WHATSAPP INGEST:', JSON.stringify(summary));
      })
      .catch((error) => {
        console.error('Webhook ingest failed:', error.message);
      });
  })
);