import { z } from 'zod';
import { ToolCallSchema, ToolResultSchema } from './tools.js';

export const TraceEntrySchema = z.object({
  id: z.string(),
  ts: z.number(),
  source: z.enum(['user', 'llm', 'vlm', 'system']),
  input: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).default([]),
  toolResults: z.array(ToolResultSchema).default([]),
  ok: z.boolean().default(true),
  error: z.string().optional(),
});

export type TraceEntry = z.infer<typeof TraceEntrySchema>;
