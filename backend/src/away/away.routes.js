import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { HttpError } from '../lib/HttpError.js';
import { DAY_NAMES, getAwaySettings, updateAwaySettings } from './away.repository.js';
import { evaluateAwayWindow } from './away.service.js';

export const awaySettingsRouter = Router();

// Module 6: the Away Message is a global, Admin-only setting. Agents are
// refused here by the backend, not merely by a hidden button in the UI.
awaySettingsRouter.use(authenticate);
awaySettingsRouter.use(requireRole('admin'));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects 2026-02-31 style dates, not just a bad shape. */
function isRealDate(value) {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const dayEntry = z.object({
  day: z.number().int().min(0).max(6),
  enabled: z.boolean(),
  from: z.string().regex(TIME, 'Use a 24-hour HH:MM time, for example 09:00'),
  to: z.string().regex(TIME, 'Use a 24-hour HH:MM time, for example 18:00'),
});

// Module 9: public holidays. Optional so old clients that never send it keep
// working; when present each item must be a real 'YYYY-MM-DD' date.
const holidaysShape = z
  .array(
    z
      .string()
      .trim()
      .refine(isRealDate, 'Use a real date in YYYY-MM-DD format')
  )
  .max(366, 'Too many holidays')
  .optional();

const settingsBody = z.object({
  enabled: z.boolean(),
  message: z.string().trim().min(1, 'Away Message text cannot be empty').max(4000),
  timezone: z.string().trim().min(1).max(64),
  holidays: holidaysShape,
  schedule: z
    .array(dayEntry)
    .length(7, 'The schedule needs all seven days')
    .superRefine((schedule, ctx) => {
      const days = schedule.map((entry) => entry.day);
      if (new Set(days).size !== 7) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Each weekday may appear only once (0 = Sunday … 6 = Saturday)',
        });
        return;
      }
      for (const entry of schedule) {
        if (!entry.enabled) continue;
        if (entry.to <= entry.from) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${DAY_NAMES[entry.day]}: office hours must finish after they start (${entry.from} → ${entry.to})`,
            path: [schedule.indexOf(entry), 'to'],
          });
        }
      }
    }),
});

/** Rejects zones Intl does not know before they reach the database. */
function assertKnownTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new HttpError(400, `"${timezone}" is not a recognised timezone (use an IANA name such as Asia/Kolkata)`);
  }
}

/** GET — the saved configuration plus what the webhook would do right now. */
awaySettingsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const settings = await getAwaySettings();
    res.json({ settings, evaluation: evaluateAwayWindow(settings) });
  })
);

/** PUT — replace the whole configuration (the admin form submits everything). */
awaySettingsRouter.put(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = settingsBody.parse(req.body);
    assertKnownTimezone(parsed.timezone);

    const settings = await updateAwaySettings(parsed);
    res.json({ settings, evaluation: evaluateAwayWindow(settings) });
  })
);

/**
 * POST /test — simulation only. It runs the exact same decision function the
 * webhook uses and returns the outcome plus the message that would go out.
 * Nothing is written and no WhatsApp message is ever sent from here, so an
 * operator can never accidentally message a real customer.
 */
awaySettingsRouter.post(
  '/test',
  asyncRoute(async (req, res) => {
    const draft = req.body && Object.keys(req.body).length > 0 ? settingsBody.parse(req.body) : null;
    if (draft) assertKnownTimezone(draft.timezone);

    const settings = draft ?? (await getAwaySettings());
    const evaluation = evaluateAwayWindow(settings);

    res.json({
      simulated: true,
      sent: false,
      evaluation,
      preview: settings.message,
      cooldownHours: 24,
    });
  })
);
