import { z } from 'zod';

export const ToolCallSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).optional(),
  explain: z.string().optional(),
});

export const ToolResultSchema = z.object({
  tool: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
