import { z } from 'zod';

const boolFromQuery = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1'
  );

export const listTasksQuery = z.object({
  completed: boolFromQuery.optional(),
  sort: z.enum(['created_desc', 'created_asc', 'title_asc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const createTaskBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  completed: z.boolean().optional(),
});

export const updateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    completed: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

export const idParam = z.object({
  id: z.coerce.number().int().positive(),
});