import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ClientRequestSchema, PROTOCOL_VERSION } from '../../shared/schema/index.js';
import type { ServerEvent, ServerResponse, TraceEntry, ToolResult } from '../../shared/schema/index.js';
import { MCPToolRequestSchema } from '../../shared/schema/mcpToolsV3.js';
import { routeAndExecute } from './router/router.js';
import type { RouterContext, RouterToolResult, VlmMateCapture } from './router/types.js';
import { analyzeVlm } from './vlm/analyze.js';
import { inferMateFromImages } from './vlm/mateInfer.js';
import { inferMateParams } from './router/mateParamsInfer.js';

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
const ROUTER_MAX_ITERATIONS = Number(process.env.ROUTER_MAX_ITERATIONS || 3);
const ROUTER_MAX_TOOL_RESULTS_FOR_CONTEXT = Number(process.env.ROUTER_MAX_TOOL_RESULTS_FOR_CONTEXT || 8);
const ROUTER_RESULT_MAX_DEPTH = 4;
const ROUTER_RESULT_MAX_ARRAY = 12;
const ROUTER_RESULT_MAX_OBJECT_KEYS = 16;
const ROUTER_RESULT_MAX_STRING = 320;

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

  private normalizeRouterIterations() {
    if (!Number.isFinite(ROUTER_MAX_ITERATIONS)) return 3;
    return Math.max(1, Math.min(8, Math.floor(ROUTER_MAX_ITERATIONS)));
  }

  private summarizeValueForRouter(value: unknown, depth = 0): unknown {
    if (value == null) return value;
    if (typeof value === 'string') {
      return value.length > ROUTER_RESULT_MAX_STRING
        ? `${value.slice(0, ROUTER_RESULT_MAX_STRING)}…`
        : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= ROUTER_RESULT_MAX_DEPTH) return '[truncated]';
    if (Array.isArray(value)) {
      return value
        .slice(0, ROUTER_RESULT_MAX_ARRAY)
        .map((item) => this.summarizeValueForRouter(item, depth + 1));
    }
    if (typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, val] of Object.entries(source)) {
        if (count >= ROUTER_RESULT_MAX_OBJECT_KEYS) break;
        if (key === 'dataUrl' && typeof val === 'string') {
          out[key] = val.length > 96 ? `${val.slice(0, 96)}…` : val;
        } else {
          out[key] = this.summarizeValueForRouter(val, depth + 1);
        }
        count += 1;
      }
      return out;
    }
    return String(value);
  }

  private summarizeToolResultForRouter(result: ToolResult, iteration: number): RouterToolResult {
    return {
      tool: result.tool,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.result !== undefined ? { result: this.summarizeValueForRouter(result.result) } : {}),
      iteration,
    };
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
            const args = (parsed.data.args ?? {}) as { text?: string; context?: RouterContext };
            const text = args.text || '';
            const baseCtx: RouterContext = {
              parts: [],
              ...(args.context || {}),
            };
            const allToolCalls: TraceEntry['toolCalls'] = [];
            const allToolResults: ToolResult[] = [];
            const routerContextResults: RouterToolResult[] = Array.isArray(baseCtx.toolResults)
              ? [...baseCtx.toolResults]
              : [];
            const maxIterations = this.normalizeRouterIterations();
            let lastReplyText: string | undefined;
            let iterationsUsed = 0;

            // Pre-fetch VLM capture for mate commands on first iteration.
            // Runs before routeAndExecute so the router can use VLM-inferred params.
            let vlmMateCapture: VlmMateCapture | null = null;
            const mateVlmEnabled =
              process.env.MATE_VLM_ENABLE === '1' ||
              Boolean(process.env.MATE_VLM_MOCK_RESPONSE);
            if (mateVlmEnabled) {
              const MATE_KW = ['mate', '對齊', '对齐', '組裝', '组装', '裝配', '装配', 'align', 'attach', 'fit'];
              const lowerText = text.toLowerCase();
              const hasMateKeyword = MATE_KW.some((k) => lowerText.includes(k));
              const mentionedParts = baseCtx.parts.filter((p) =>
                lowerText.includes(p.name.toLowerCase())
              );
              if (hasMateKeyword && mentionedParts.length >= 2) {
                try {
                  const captureResult = await this.requestToolExecutionViaProxy(
                    ws,
                    `${parsed.data.id}:vlm_capture`,
                    {
                      tool: 'vlm.capture_for_mate',
                      args: {
                        sourcePart: { partId: mentionedParts[0]!.id },
                        targetPart: { partId: mentionedParts[1]!.id },
                        userText: text,
                        maxWidthPx: 512,
                        maxHeightPx: 384,
                        confidenceThreshold: Number(process.env.MATE_VLM_CONFIDENCE || '0.75'),
                      },
                    }
                  ) as any;
                  if (captureResult?.ok && captureResult.data) {
                    vlmMateCapture = captureResult.data as VlmMateCapture;
                  }
                } catch {
                  // Silent failure — fall through to NLP inference
                }
              }
            }

            for (let iteration = 0; iteration < maxIterations; iteration++) {
              iterationsUsed = iteration + 1;
              const routed = await routeAndExecute(text, {
                ...baseCtx,
                iteration,
                toolResults: routerContextResults.slice(-ROUTER_MAX_TOOL_RESULTS_FOR_CONTEXT),
                ...(vlmMateCapture !== null ? { vlmMateCapture } : {}),
              });
              lastReplyText = routed.replyText ?? lastReplyText;

              if (routed.toolCalls.length === 0) break;

              allToolCalls.push(...routed.toolCalls);

              const iterationResults: ToolResult[] = [];
              for (const call of routed.toolCalls) {
                const toolRequestParsed = MCPToolRequestSchema.safeParse({
                  tool: call.tool,
                  args: call.args ?? {},
                });

                if (!toolRequestParsed.success) {
                  iterationResults.push({
                    tool: call.tool,
                    ok: false,
                    error: 'Invalid MCP tool request generated by router',
                  });
                  continue;
                }

                try {
                  const result = await this.requestToolExecutionViaProxy(
                    ws,
                    `${parsed.data.id}:iter${iteration}:${call.tool}`,
                    toolRequestParsed.data
                  );
                  iterationResults.push({
                    tool: call.tool,
                    ok: true,
                    result,
                  });
                } catch (error: any) {
                  iterationResults.push({
                    tool: call.tool,
                    ok: false,
                    error: error?.message || 'Tool execution failed',
                  });
                }
              }

              allToolResults.push(...iterationResults);
              routerContextResults.push(
                ...iterationResults.map((result) => this.summarizeToolResultForRouter(result, iteration))
              );

              const isPlanningRound = routed.toolCalls.every((call) => {
                if (call.tool === 'view.capture_image') return true;
                return call.tool.startsWith('query.');
              });
              if (!isPlanningRound) break;
            }

            const trace: TraceEntry = {
              id: randomUUID(),
              ts: Date.now(),
              source: 'llm',
              input: text,
              toolCalls: allToolCalls,
              toolResults: allToolResults,
              ok: allToolResults.every((result) => result.ok),
            };

            const successCount = allToolResults.filter((result) => result.ok).length;
            const failCount = allToolResults.length - successCount;
            const replyText =
              lastReplyText ??
              (allToolResults.length === 0
                ? '我還不確定要執行哪個功能。'
                : failCount === 0
                ? `已完成 ${successCount} 個動作。`
                : `已完成 ${successCount} 個動作，${failCount} 個動作失敗。`);

            this.sendResponse(
              ws,
              parsed.data.id,
              true,
              {
                trace,
                results: allToolResults,
                replyText,
                meta: {
                  iterations: iterationsUsed,
                  maxIterations,
                },
              },
              undefined,
              trace.id
            );
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

          if (parsed.data.command === 'vlm_mate_analyze') {
            const args = (parsed.data.args ?? {}) as {
              images?: { angle: string; dataUrl: string }[];
              sceneState?: {
                parts: { id: string; name: string; position: [number, number, number] }[];
                sourcePart: { id: string; name: string };
                targetPart: { id: string; name: string };
                userText: string;
              };
            };
            const inference = await inferMateFromImages(
              args.images ?? [],
              args.sceneState ?? {
                parts: [],
                sourcePart: { id: '', name: '' },
                targetPart: { id: '', name: '' },
                userText: '',
              }
            );
            this.sendResponse(ws, parsed.data.id, true, { inference });
            return;
          }

          if (parsed.data.command === 'agent.infer_mate_params') {
            const mateArgs = (parsed.data.args ?? {}) as {
              userText?: string;
              sourcePart?: { id: string; name: string };
              targetPart?: { id: string; name: string };
              geometryHint?: Record<string, unknown>;
            };
            const inference = await inferMateParams({
              userText: mateArgs.userText ?? '',
              sourcePart: mateArgs.sourcePart ?? { id: '', name: '' },
              targetPart: mateArgs.targetPart ?? { id: '', name: '' },
              geometryHint: mateArgs.geometryHint as any,
            });
            this.sendResponse(ws, parsed.data.id, true, { inference });
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
