import { z } from 'zod';

/**
 * Module 10 — request validation for follow-up reminders.
 *
 * `dueAt` arrives as an ISO-8601 string from the browser (the frontend converts
 * the user's local `datetime-local` value to UTC before sending) and is parsed
 * straight to a Date so PostgreSQL stores it as TIMESTAMPTZ.
 */

export const reminderIdParam = z.object({ id: z.coerce.number().int().positive() });

const title = z.string().trim().min(1, 'Reminder title is required').max(200);
const notes = z.string().trim().max(2000);
const dueAt = z.coerce.date({ invalid_type_error: 'A valid due date and time is required' });

export const createReminderBody = z.object({
  conversationId: z.coerce.number().int().positive('A conversation is required'),
  title,
  notes: notes.optional(),
  dueAt,
});

export const updateReminderBody = z
  .object({
    title: title.optional(),
    notes: notes.optional(),
    dueAt: dueAt.optional(),
  })
  .refine((value) => value.title !== undefined || value.notes !== undefined || value.dueAt !== undefined, {
    message: 'Provide at least one field to update',
  });

const FILTERS = ['all', 'due_today', 'upcoming', 'overdue', 'completed', 'cancelled', 'pending'];

export const listRemindersQuery = z.object({
  filter: z.enum(FILTERS).optional(),
  search: z.string().trim().max(120).optional(),
  conversationId: z.coerce.number().int().positive().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
