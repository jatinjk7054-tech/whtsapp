import { z } from 'zod';

export const notificationIdParam = z.object({ id: z.coerce.number().int().positive() });

const booleanParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const listNotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  unreadOnly: booleanParam.optional(),
});
