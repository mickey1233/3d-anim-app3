import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ClientRequestSchema, PROTOCOL_VERSION } from '../../shared/schema/index.js';
import type { ServerEvent, ServerResponse, TraceEntry, ToolResult } from '../../shared/schema/index.js';
import { MCPToolRequestSchema } from '../../shared/schema/mcpToolsV3.js';
import { routeAndExecute } from './router/router.js';
import type { RouterContext, RouterToolResult, RouteMeta, VlmMateCapture } from './router/types.js';
import { analyzeVlm } from './vlm/analyze.js';
import { inferAssemblySequence } from './vlm/autoAssemble.js';
import { verifyAnchorFace, logAnchorVerifyFailure } from './vlm/anchorVerify.js';
import { inferMateFromImages } from './vlm/mateInfer.js';
import { inferMateParams } from './router/mateParamsInfer.js';
import { saveRecipe, deleteRecipe, listRecipes, saveDemonstration, listDemonstrations, findRelevantDemonstrations } from './router/mateRecipes.js';
import type { DemonstrationPriorScore } from '../../shared/schema/assemblySemanticTypes.js';
import { queryWeather, queryWebSearch } from './web/queryTools.js';
import { getServerStatus } from './status/serverStatus.js';
import { labelPart } from './vlm/partLabeler.js';

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

const TOOL_PROXY_TIMEOUT_MS = Number(process.env.TOOL_PROXY_TIMEOUT_MS || 120_000);
const ROUTER_MAX_ITERATIONS = Number(process.env.ROUTER_MAX_ITERATIONS || 3);
const ROUTER_MAX_TOOL_RESULTS_FOR_CONTEXT = Number(process.env.ROUTER_MAX_TOOL_RESULTS_FOR_CONTEXT || 8);
const ROUTER_RESULT_MAX_DEPTH = 4;
const ROUTER_RESULT_MAX_ARRAY = 12;
const ROUTER_RESULT_MAX_OBJECT_KEYS = 16;
const ROUTER_RESULT_MAX_STRING = 320;

export class WsGatewayV2 {
  private wss: WebSocketServer;
  private pendingProxyRequests = new Map<string, PendingProxyRequest>();

  constructor(portOrServer: number | HttpServer, host?: string) {
    if (typeof portOrServer === 'number') {
      this.wss = new WebSocketServer(host ? { port: portOrServer, host } : { port: portOrServer });
    } else {
      this.wss = new WebSocketServer({ server: portOrServer });
    }
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
        } else if (key === 'arbitration' && Array.isArray(val)) {
          out[key] = val
            .slice(0, 6)
            .map((item) => (typeof item === 'string' ? item : this.summarizeValueForRouter(item, depth + 1)));
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
            let routeMeta: RouteMeta | undefined;
            let pendingIntent: import('./router/types.js').PendingIntent | null | undefined;
            let iterationsUsed = 0;
            const routerStartedAt = Date.now();
            const iterationTimings: Array<{
              iteration: number;
              routeMs: number;
              toolsMs: number;
              totalMs: number;
              tools: Array<{ tool: string; ok: boolean; ms: number }>;
            }> = [];

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
              const iterationStartedAt = Date.now();
              const routeStartedAt = Date.now();
              const routed = await routeAndExecute(text, {
                ...baseCtx,
                iteration,
                toolResults: routerContextResults.slice(-ROUTER_MAX_TOOL_RESULTS_FOR_CONTEXT),
                ...(vlmMateCapture !== null ? { vlmMateCapture } : {}),
              });
              const routeMs = Math.max(0, Date.now() - routeStartedAt);
              lastReplyText = routed.replyText ?? lastReplyText;
              if (iteration === 0 && routed.routeMeta) routeMeta = routed.routeMeta;
              // Carry pendingIntent from the first iteration (clarification turn)
              if (iteration === 0 && routed.pendingIntent !== undefined) pendingIntent = routed.pendingIntent;

              if (routed.toolCalls.length === 0) break;

              allToolCalls.push(...routed.toolCalls);

              const iterationResults: ToolResult[] = [];
              const iterationToolTimings: Array<{ tool: string; ok: boolean; ms: number }> = [];
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
                  iterationToolTimings.push({
                    tool: call.tool,
                    ok: false,
                    ms: 0,
                  });
                  continue;
                }

                const toolStartedAt = Date.now();
                try {
                  let result: unknown;
                  if (toolRequestParsed.data.tool === 'query.web_search') {
                    result = await queryWebSearch(toolRequestParsed.data.args as any);
                  } else if (toolRequestParsed.data.tool === 'query.weather') {
                    result = await queryWeather(toolRequestParsed.data.args as any);
                  } else {
                    result = await this.requestToolExecutionViaProxy(
                      ws,
                      `${parsed.data.id}:iter${iteration}:${call.tool}`,
                      toolRequestParsed.data
                    );
                  }
                  iterationResults.push({
                    tool: call.tool,
                    ok: true,
                    result,
                  });
                  iterationToolTimings.push({
                    tool: call.tool,
                    ok: true,
                    ms: Math.max(0, Date.now() - toolStartedAt),
                  });
                } catch (error: any) {
                  iterationResults.push({
                    tool: call.tool,
                    ok: false,
                    error: error?.message || 'Tool execution failed',
                  });
                  iterationToolTimings.push({
                    tool: call.tool,
                    ok: false,
                    ms: Math.max(0, Date.now() - toolStartedAt),
                  });
                }
              }

              allToolResults.push(...iterationResults);
              routerContextResults.push(
                ...iterationResults.map((result) => this.summarizeToolResultForRouter(result, iteration))
              );
              const toolsMs = iterationToolTimings.reduce((sum, row) => sum + row.ms, 0);
              iterationTimings.push({
                iteration,
                routeMs,
                toolsMs,
                totalMs: Math.max(0, Date.now() - iterationStartedAt),
                tools: iterationToolTimings,
              });

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

            // Build a richer reply for smart_mate_execute results
            const smartMateResult = allToolResults.find(
              (r) => r.tool === 'action.smart_mate_execute' && r.ok
            ) as any;
            const smartMateReply = smartMateResult
              ? (() => {
                  const d = smartMateResult.result?.data ?? smartMateResult.result;
                  const src = d?.source?.partName ?? d?.source?.partId ?? '?';
                  const tgt = d?.target?.partName ?? d?.target?.partId ?? '?';
                  const sf = d?.chosen?.sourceFace ?? '?';
                  const tf = d?.chosen?.targetFace ?? '?';
                  const mode = d?.chosen?.mode ?? '?';
                  const sm = d?.chosen?.sourceMethod ?? '?';
                  const tm = d?.chosen?.targetMethod ?? '?';
                  const desc = typeof d?.actionDescription === 'string' ? d.actionDescription : null;
                  const base = `✓ 已組裝 ${src}(${sf}, ${sm}) → ${tgt}(${tf}, ${tm})，mode: ${mode}`;
                  return desc ? `${desc}\n${base}` : base;
                })()
              : null;

            const replyText =
              smartMateReply ??
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
                  timings: {
                    totalMs: Math.max(0, Date.now() - routerStartedAt),
                    iterationTimings,
                  },
                  ...(routeMeta ? { routeMeta } : {}),
                  ...(pendingIntent !== undefined ? { pendingIntent } : {}),
                },
              },
              undefined,
              trace.id
            );
            return;
          }

          if (parsed.data.command === 'server_status') {
            const status = await getServerStatus();
            this.sendResponse(ws, parsed.data.id, true, status);
            return;
          }

          if (parsed.data.command === 'vlm_analyze') {
            const args = (parsed.data.args ?? {}) as { images?: any[]; parts?: any[]; mateContext?: unknown };
            const images = args.images || [];
            const parts = args.parts || [];
            const result = await analyzeVlm(images, parts, { mateContext: args.mateContext });
            this.sendResponse(ws, parsed.data.id, true, result);
            return;
          }

          if (parsed.data.command === 'anchor_verify') {
            const args = (parsed.data.args ?? {}) as {
              imageBase64?: string;
              mime?: string;
              faceId?: string;
              partName?: string;
              logFailure?: boolean;
              triedMethods?: string[];
              vlmReasons?: Record<string, string>;
            };
            if (args.logFailure) {
              logAnchorVerifyFailure({
                partName: args.partName || 'unknown',
                faceId: args.faceId || 'unknown',
                triedMethods: args.triedMethods || [],
                vlmReasons: args.vlmReasons || {},
              });
              this.sendResponse(ws, parsed.data.id, true, { logged: true });
              return;
            }
            const result = await verifyAnchorFace(
              args.imageBase64 || '',
              args.mime || 'image/jpeg',
              args.faceId || 'top',
              args.partName || 'part',
            );
            this.sendResponse(ws, parsed.data.id, true, result);
            return;
          }

          if (parsed.data.command === 'vlm_auto_assemble') {
            const args = (parsed.data.args ?? {}) as { images?: any[]; parts?: any[] };
            const images = args.images || [];
            const parts = args.parts || [];
            const steps = await inferAssemblySequence(images, parts);
            this.sendResponse(ws, parsed.data.id, true, { steps });
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

          if (parsed.data.command === 'agent.save_mate_recipe') {
            const args = (parsed.data.args ?? {}) as {
              sourceName?: string;
              targetName?: string;
              sourceFace?: string;
              targetFace?: string;
              sourceMethod?: string;
              targetMethod?: string;
              note?: string;
              whyDescription?: string;
              pattern?: string;
              antiPattern?: string;
              geometrySignal?: string;
            };
            if (!args.sourceName || !args.targetName || !args.sourceFace || !args.targetFace) {
              this.sendResponse(ws, parsed.data.id, false, undefined, {
                message: 'save_mate_recipe requires sourceName, targetName, sourceFace, targetFace',
                code: 'INVALID_ARGUMENT',
              });
              return;
            }
            const saved = await saveRecipe({
              sourceName: args.sourceName,
              targetName: args.targetName,
              sourceFace: args.sourceFace,
              targetFace: args.targetFace,
              sourceMethod: args.sourceMethod ?? 'planar_cluster',
              targetMethod: args.targetMethod ?? 'planar_cluster',
              note: args.note,
              whyDescription: args.whyDescription,
              pattern: args.pattern,
              antiPattern: args.antiPattern,
              geometrySignal: args.geometrySignal,
            });
            console.log(`[wsGateway] Saved mate recipe: ${saved.sourceName} ↔ ${saved.targetName}`);
            this.sendResponse(ws, parsed.data.id, true, { saved });
            return;
          }

          if (parsed.data.command === 'agent.delete_mate_recipe') {
            const args = (parsed.data.args ?? {}) as { sourceName?: string; targetName?: string };
            if (!args.sourceName || !args.targetName) {
              this.sendResponse(ws, parsed.data.id, false, undefined, { message: 'delete_mate_recipe requires sourceName and targetName', code: 'INVALID_ARGUMENT' });
              return;
            }
            const deleted = await deleteRecipe(args.sourceName, args.targetName);
            this.sendResponse(ws, parsed.data.id, true, { deleted });
            return;
          }

          if (parsed.data.command === 'agent.list_mate_recipes') {
            const recipes = await listRecipes();
            this.sendResponse(ws, parsed.data.id, true, { recipes });
            return;
          }

          if (parsed.data.command === 'agent.save_demonstration') {
            const args = (parsed.data.args ?? {}) as {
              id?: string;
              timestamp?: string;
              sourcePartId?: string;
              sourcePartName?: string;
              targetPartId?: string;
              targetPartName?: string;
              chosenCandidateId?: string;
              chosenFeaturePairs?: Array<{
                sourceFeatureId: string; sourceFeatureType: string;
                targetFeatureId: string; targetFeatureType: string;
                compatibilityScore: number; dimensionFitScore: number;
                axisAlignmentScore: number; notes: string[];
              }>;
              finalTransform?: {
                translation: [number,number,number];
                rotation: [number,number,number,number];
                approachDirection: [number,number,number];
                method: string;
                residualError: number;
              };
              textExplanation?: string;
              antiPattern?: string;
              generalizedRule?: string;
              sceneSnapshot?: Record<string, { position: [number,number,number]; quaternion: [number,number,number,number] }>;
            };
            if (!args.sourcePartId || !args.targetPartId) {
              this.sendResponse(ws, parsed.data.id, false, undefined, {
                message: 'save_demonstration requires sourcePartId and targetPartId',
                code: 'INVALID_ARGUMENT',
              });
              return;
            }
            const record = await saveDemonstration({
              id: args.id ?? crypto.randomUUID(),
              timestamp: args.timestamp ?? new Date().toISOString(),
              sourcePartId: args.sourcePartId,
              sourcePartName: args.sourcePartName ?? args.sourcePartId,
              targetPartId: args.targetPartId,
              targetPartName: args.targetPartName ?? args.targetPartId,
              chosenCandidateId: args.chosenCandidateId,
              chosenFeaturePairs: args.chosenFeaturePairs,
              finalTransform: args.finalTransform,
              textExplanation: args.textExplanation,
              antiPattern: args.antiPattern,
              generalizedRule: args.generalizedRule,
              sceneSnapshot: args.sceneSnapshot,
            });
            console.log(`[wsGateway] Saved demonstration: ${record.sourcePartName} → ${record.targetPartName} (${record.id})`);
            this.sendResponse(ws, parsed.data.id, true, { saved: true, demonstrationId: record.id });
            return;
          }

          if (parsed.data.command === 'agent.list_demonstrations') {
            const demonstrations = await listDemonstrations();
            this.sendResponse(ws, parsed.data.id, true, { demonstrations });
            return;
          }

          if (parsed.data.command === 'agent.vlm_rerank_candidates') {
            // VLM-based candidate reranking via LLM.
            // Input: { source: string, target: string, candidates: [{id, description, primaryFeatureTypes, score}] }
            // Output: [{ candidateId, semanticScore, reason, reject }]
            try {
              const rrArgs = (parsed.data.args ?? {}) as {
                source?: string;
                target?: string;
                candidates?: Array<{ id: string; description?: string; primaryFeatureTypes?: string[]; score?: number }>;
              };
              if (!rrArgs.candidates || rrArgs.candidates.length === 0) {
                this.sendResponse(ws, parsed.data.id, true, { reranked: [] });
                return;
              }

              const { callAgentLlm } = await import('./router/agentLlm.js');
              const systemPrompt =
                'You are a mechanical assembly expert. Rank these assembly candidates by semantic plausibility.\n' +
                'Output ONLY a valid JSON array (no markdown): [{"candidateId": "...", "semanticScore": 0.0-1.0, "reason": "...", "reject": false}]\n' +
                'semanticScore=1.0 means highly plausible, 0.0 means implausible. reject=true if you are confident it is wrong.';
              const userMessage =
                `Task: Rerank assembly candidates for ${rrArgs.source ?? 'source'} → ${rrArgs.target ?? 'target'}\n` +
                `Candidates: ${JSON.stringify(rrArgs.candidates, null, 2)}`;

              const llmResult = await callAgentLlm(systemPrompt, userMessage);
              // Parse the replyText as JSON array
              let reranked: Array<{ candidateId: string; semanticScore: number; reason: string; reject: boolean }> = [];
              try {
                const text = llmResult?.replyText?.trim() ?? '';
                const start = text.indexOf('[');
                const end = text.lastIndexOf(']');
                if (start >= 0 && end > start) {
                  reranked = JSON.parse(text.slice(start, end + 1));
                }
              } catch {
                // If parse fails, return empty — caller handles gracefully
              }
              this.sendResponse(ws, parsed.data.id, true, { reranked });
            } catch (err: any) {
              console.warn('[wsGateway] agent.vlm_rerank_candidates failed:', err?.message);
              this.sendResponse(ws, parsed.data.id, true, { reranked: [] });
            }
            return;
          }

          if (parsed.data.command === 'agent.find_relevant_demonstrations') {
            const { sourceName, targetName, featureTypeHints } = (parsed.data.args ?? {}) as {
              sourceName: string;
              targetName: string;
              featureTypeHints?: string[];
            };
            const scores: DemonstrationPriorScore[] = await findRelevantDemonstrations({
              sourcePartName: sourceName ?? '',
              targetPartName: targetName ?? '',
              ...(featureTypeHints ? { featureTypes: featureTypeHints } : {}),
            });
            this.sendResponse(ws, parsed.data.id, true, { scores });
            return;
          }

          if (parsed.data.command === 'agent.label_part') {
            const { partId, partName, geometrySummary } = (parsed.data.args ?? {}) as {
              partId: string;
              partName: string;
              geometrySummary?: { bboxSize?: [number, number, number]; featureTypes?: string[]; featureCount?: number };
            };
            try {
              const label = await labelPart({ partName: partName ?? partId, geometrySummary });
              this.sendResponse(ws, parsed.data.id, true, { partId, label });
            } catch {
              this.sendResponse(ws, parsed.data.id, true, { partId, label: null });
            }
            return;
          }

          if (parsed.data.command === 'agent.parse_grounding_concepts') {
            const { utterance, scenePartNames } = (parsed.data.args ?? {}) as {
              utterance: string;
              scenePartNames?: string[];
            };
            try {
              const { callAgentLlm } = await import('./router/agentLlm.js');
              const systemPrompt = `You are a CAD assembly intent parser. Extract the source part concept and target part concept from the user's assembly command.

Output ONLY valid JSON:
{
  "sourceConcept": "the thing that moves or gets attached, e.g. fan or 風扇",
  "targetConcept": "the fixed reference part, e.g. chassis or 機殼",
  "assemblyIntent": "mount|insert|cover|slide|screw|default",
  "utteranceType": "explicit_names|deictic|conceptual|mixed|unknown",
  "usesDeictic": false,
  "confidence": 0.8
}

If the user uses deictic references (這個, this, etc.), set usesDeictic=true and leave sourceConcept/targetConcept empty.
Available parts in scene: ${scenePartNames?.slice(0, 20).join(', ') ?? 'unknown'}`;

              const result = await callAgentLlm(systemPrompt, `User command: "${utterance}"\nParse the assembly intent:`);
              const text = result?.replyText?.trim() ?? '';
              const s = text.indexOf('{'), e = text.lastIndexOf('}');
              let parsedConcepts: unknown = null;
              if (s >= 0 && e > s) {
                try { parsedConcepts = JSON.parse(text.slice(s, e + 1)); } catch { /* */ }
              }
              this.sendResponse(ws, parsed.data.id, true, { concepts: parsedConcepts });
            } catch {
              this.sendResponse(ws, parsed.data.id, true, { concepts: null });
            }
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
              let result: unknown;
              if (toolRequestParsed.data.tool === 'query.web_search') {
                result = await queryWebSearch(toolRequestParsed.data.args as any);
              } else if (toolRequestParsed.data.tool === 'query.weather') {
                result = await queryWeather(toolRequestParsed.data.args as any);
              } else {
                result = await this.requestToolExecutionViaProxy(ws, parsed.data.id, toolRequestParsed.data);
              }
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
