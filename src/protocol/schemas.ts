import { z } from 'zod';

import { historyMessageSchema } from '../config/schema.js';

export const verifyRequestSchema = z.object({
  type: z.literal('verification'),
  challenge: z.string().min(1),
});

export const turnRequestSchema = z.object({
  request_id: z.string().min(1),
  conversation_id: z.string().min(1).max(128).regex(/^[\w-]+$/, 'conversation_id must be alphanumeric, hyphens, or underscores'),
  message: z.string().min(1),
  history: z.array(historyMessageSchema),
}).strict();
