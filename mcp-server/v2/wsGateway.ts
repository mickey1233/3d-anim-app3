import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ClientRequestSchema, PROTOCOL_VERSION } from '../../shared/schema/index.js';
import type { ServerEvent, ServerResponse } from '../../shared/schema/index.js';
import { MCPToolRequestSchema } from '../../shared/schema/mcpToolsV3.js';
import { routeAndExecute } from './router/router.js';
import { analyzeVlm } from './vlm/analyze.js';

const ToolProxyResultSchema = z.object({
  proxyId: z.string().min(1),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
      details: z.unknown().optional(),
    })
    .optional(),
});

type PendingProxyRequest = {
  ws: WebSocket;
  requestId: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const TOOL_PROXY_TIMEOUT_MS = 20_000;

export class WsGatewayV2 {
  private wss: WebSocketServer;
  private pendingProxyRequests = new Map<string, PendingProxyRequest>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
  }

  private sendResponse(
    ws: WebSocket,
    id: string,
    ok: boolean,
    result?: unknown,
    error?: { message: string; code?: string; details?: unknown },
    traceId?: string
  ) {
    const response: ServerResponse = {
      version: PROTOCOL_VERSION,
      id,
      type: 'server_response',
      ok,
      ...(result === undefined ? {} : { result }),
      ...(error ? { error } : {}),
      ...(traceId ? { traceId } : {}),
    };
    ws.send(JSON.stringify(response));
  }

  private sendEvent(ws: WebSocket, event: ServerEvent['event'], payload: unknown) {
    const message: ServerEvent = {
      version: PROTOCOL_VERSION,
      type: 'server_event',
      event,
      payload,
    };
    ws.send(JSON.stringify(message));
  }

  private rejectSocketPendingRequests(ws: WebSocket) {
    for (const [proxyId, pending] of this.pendingProxyRequests.entries()) {
      if (pending.ws !== ws) continue;
      clearTimeout(pending.timeout);
      this.pendingProxyRequests.delete(proxyId);
      pending.reject(new Error('Tool proxy client disconnected'));
    }
  }

  private requestToolExecutionViaProxy(ws: WebSocket, requestId: string, toolRequest: unknown) {
    const proxyId = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingProxyRequests.delete(proxyId);
        reject(new Error(`Tool proxy timeout (${TOOL_PROXY_TIMEOUT_MS}ms)`));
      }, TOOL_PROXY_TIMEOUT_MS);

      this.pendingProxyRequests.set(proxyId, {
        ws,
        requestId,
        timeout,
        resolve,
        reject,
      });

      this.sendEvent(ws, 'tool_proxy_invoke', {
        proxyId,
        request: toolRequest,
      });
    });
  }

  start() {
    this.wss.on('connection', (ws) => {
      ws.on('close', () => {
        this.rejectSocketPendingRequests(ws);
      });

      ws.on('message', async (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          const parsed = ClientRequestSchema.safeParse(data);
          if (!parsed.success) {
            this.sendResponse(ws, data?.id ?? 'unknown', false, undefined, {
              message: 'Invalid request schema',
              code: 'INVALID_REQUEST',
              details: parsed.error.flatten(),
            });
            return;
          }

          if (parsed.data.command === 'router_execute') {
            const args = (parsed.data.args ?? {}) as { text?: string; context?: any };
            const text = args.text || '';
            const ctx = args.context || { parts: [] };
            const { trace, results } = await routeAndExecute(text, ctx);
            this.sendResponse(ws, parsed.data.id, true, { trace, results }, undefined, trace.id);
            return;
          }

          if (parsed.data.command === 'vlm_analyze') {
            const args = (parsed.data.args ?? {}) as { images?: any[]; parts?: any[] };
            const images = args.images || [];
            const parts = args.parts || [];
            const result = await analyzeVlm(images, parts);
            this.sendResponse(ws, parsed.data.id, true, result);
            return;
          }

          if (parsed.data.command === 'mcp_tool_call') {
            const toolRequestParsed = MCPToolRequestSchema.safeParse(parsed.data.args ?? {});
            if (!toolRequestParsed.success) {
              this.sendResponse(ws, parsed.data.id, false, undefined, {
                message: 'Invalid mcp_tool_call args',
                code: 'INVALID_TOOL_REQUEST',
                details: toolRequestParsed.error.flatten(),
              });
              return;
            }

            try {
              const result = await this.requestToolExecutionViaProxy(ws, parsed.data.id, toolRequestParsed.data);
              this.sendResponse(ws, parsed.data.id, true, result);
            } catch (error: any) {
              this.sendResponse(ws, parsed.data.id, false, undefined, {
                message: error?.message || 'Tool proxy failed',
                code: 'TOOL_PROXY_FAILED',
              });
            }
            return;
          }

          if (parsed.data.command === 'tool_proxy_result') {
            const payloadParsed = ToolProxyResultSchema.safeParse(parsed.data.args ?? {});
            if (!payloadParsed.success) {
              this.sendResponse(ws, parsed.data.id, false, undefined, {
                message: 'Invalid tool_proxy_result args',
                code: 'INVALID_TOOL_PROXY_RESULT',
                details: payloadParsed.error.flatten(),
              });
              return;
            }

            const { proxyId, result, error } = payloadParsed.data;
            const pending = this.pendingProxyRequests.get(proxyId);
            if (!pending) {
              this.sendResponse(ws, parsed.data.id, true, {
                ack: true,
                ignored: true,
                reason: 'proxy_id_not_found',
              });
              return;
            }

            clearTimeout(pending.timeout);
            this.pendingProxyRequests.delete(proxyId);

            if (error) pending.reject(new Error(error.message));
            else pending.resolve(result);

            this.sendResponse(ws, parsed.data.id, true, { ack: true });
            return;
          }

          this.sendResponse(ws, parsed.data.id, true, {
            message: 'v2 gateway alive (router, vlm, mcp_tool_call ready)',
          });
        } catch (e: any) {
          this.sendResponse(ws, 'unknown', false, undefined, {
            message: e.message || 'Unknown error',
            code: 'INTERNAL_ERROR',
          });
        }
      });
    });
  }
}
