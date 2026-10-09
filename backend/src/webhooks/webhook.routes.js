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

    // Safe, secret-free delivery log: method/path, the change field names, and
    // (for `calls`) how many call events / call-status events arrived. Customer
    // message content, SDP, access tokens and the app secret are NEVER logged —
    // only counts, field names and event/direction/status values.
    const changeLog = (req.body?.entry ?? []).flatMap((entry) =>
      (entry?.changes ?? []).map((change) => {
        const value = change?.value ?? {};
        const callEvents = Array.isArray(value.calls) ? value.calls : [];
        const callStatuses = Array.isArray(value.statuses) ? value.statuses : [];
        return {
          field: change?.field,
          hasMessages: Array.isArray(value.messages),
          messageCount: value.messages?.length ?? 0,
          statusCount: value.statuses?.length ?? 0,
          // Module 12: explicit call-event visibility so "no calls showing up"
          // can be told apart from "Meta never sent a calls field".
          callEventCount: callEvents.length,
          callEventNames: callEvents.map((c) => c?.event ?? null),
          callEventDirections: callEvents.map((c) => c?.direction ?? null),
          callStatusCount: callStatuses.filter((s) => String(s?.type).toLowerCase() === 'call').length,
          callStatusValues: callStatuses.map((s) => s?.status ?? null),
        };
      })
    );

    const callsDetected = changeLog.some(
      (change) => change.callEventCount > 0 || change.callStatusCount > 0
    );

    console.log(
      'WHATSAPP WEBHOOK:',
      JSON.stringify({
        method: req.method,
        path: req.originalUrl,
        object: req.body?.object,
        entries: (req.body?.entry ?? []).map((entry) => ({ entryId: entry.id })),
        fields: changeLog.map((change) => change.field),
        callsDetected,
        changes: changeLog,
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