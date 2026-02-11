import { z } from 'zod';

export const PROTOCOL_VERSION = 'v2' as const;

export const ClientRequestSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.literal('client_request'),
  command: z.string().min(1),
  args: z.unknown().optional(),
  meta: z
    .object({
      traceId: z.string().optional(),
      ts: z.number().optional(),
    })
    .optional(),
});

export const ServerResponseSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.literal('server_response'),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
      details: z.unknown().optional(),
    })
    .optional(),
  traceId: z.string().optional(),
});

export const ServerEventSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.literal('server_event'),
  event: z.enum(['trace_append', 'status', 'state_snapshot', 'tool_proxy_invoke']),
  payload: z.unknown(),
});

export const ProtocolMessageSchema = z.union([
  ClientRequestSchema,
  ServerResponseSchema,
  ServerEventSchema,
]);

export type ClientRequest = z.infer<typeof ClientRequestSchema>;
export type ServerResponse = z.infer<typeof ServerResponseSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;
