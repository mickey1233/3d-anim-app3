/**
 * agentProvider.ts — RouterProvider implementation backed by a real LLM agent.
 *
 * The LLM receives:
 *   - A system prompt built from agent-prompts/ markdown documents
 *   - A structured user context block (text + scene state)
 *
 * Env vars:
 *   AGENT_LLM_MOCK_PATH  = path to JSON mock response file (for testing)
 */

import { readFile } from 'fs/promises';
import { z } from 'zod';
import type { RouterContext, RouterProvider, RouterRoute } from './types.js';
import { buildSystemPrompt } from './promptLoader.js';
import { callAgentLlm } from './agentLlm.js';
import { mapPartReferenceToId } from './llmAssist.js';

// ---------------------------------------------------------------------------
// Validation schema for agent responses
// ---------------------------------------------------------------------------

const RawToolCallSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

const AgentResponseSchema = z.object({
  replyText: z.string(),
  toolCalls: z.array(RawToolCallSchema).default([]),
});

type ValidatedResponse = z.infer<typeof AgentResponseSchema>;

// ---------------------------------------------------------------------------
// Mock response loader (for tests)
// ---------------------------------------------------------------------------

type MockEntry = {
  replyText: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
};

type MockFile = Record<string, MockEntry>;

let mockCache: MockFile | null = null;

async function loadMockFile(mockPath: string): Promise<MockFile> {
  if (mockCache) return mockCache;
  try {
    const raw = await readFile(mockPath, 'utf-8');
    mockCache = JSON.parse(raw) as MockFile;
    return mockCache;
  } catch (err) {
    console.error('[agentProvider] Failed to load mock file:', mockPath, err);
    return {};
  }
}

async function getMockResponse(text: string, mockPath: string): Promise<RouterRoute | null> {
  const mock = await loadMockFile(mockPath);
  const lower = text.toLowerCase();
  // Use longest-key-match to avoid short keys shadowing longer specific keys
  let bestKey: string | null = null;
  let bestEntry: MockEntry | null = null;
  for (const [key, value] of Object.entries(mock)) {
    if (lower.includes(key.toLowerCase())) {
      if (bestKey === null || key.length > bestKey.length) {
        bestKey = key;
        bestEntry = value;
      }
    }
  }
  if (!bestEntry) return null;
  return {
    replyText: bestEntry.replyText,
    toolCalls: bestEntry.toolCalls.map((tc) => ({
      tool: tc.tool,
      args: tc.args,
    })),
  };
}

// ---------------------------------------------------------------------------
// Part reference resolution
// ---------------------------------------------------------------------------

function resolvePartRefs(
  toolCalls: ValidatedResponse['toolCalls'],
  parts: RouterContext['parts']
): ValidatedResponse['toolCalls'] {
  return toolCalls.map((tc) => {
    const args = { ...tc.args };
    for (const key of ['sourcePart', 'targetPart', 'part'] as const) {
      const ref = args[key];
      if (!ref || typeof ref !== 'object') continue;
      const refObj = ref as Record<string, unknown>;
      // If partId is present and valid, keep it
      if (typeof refObj.partId === 'string' && refObj.partId.length > 0) {
        const exact = parts.find((p) => p.id === refObj.partId);
        if (exact) continue;
      }
      // Try to resolve by partName or the partId as a name/fuzzy match
      const nameRef = typeof refObj.partName === 'string' ? refObj.partName : (refObj.partId as string | undefined);
      if (nameRef) {
        const resolvedId = mapPartReferenceToId(nameRef, { parts } as RouterContext);
        if (resolvedId) {
          args[key] = { partId: resolvedId };
        }
      }
    }
    // Also handle selection.set nested part ref
    if (tc.tool === 'selection.set' && args.selection && typeof args.selection === 'object') {
      const sel = args.selection as Record<string, unknown>;
      if (sel.part && typeof sel.part === 'object') {
        const partRef = sel.part as Record<string, unknown>;
        const nameRef = typeof partRef.partName === 'string' ? partRef.partName : (partRef.partId as string | undefined);
        if (nameRef) {
          const resolvedId = mapPartReferenceToId(nameRef, { parts } as RouterContext);
          if (resolvedId) {
            args.selection = { ...sel, part: { partId: resolvedId } };
          }
        }
      }
    }
    return { ...tc, args };
  });
}

// ---------------------------------------------------------------------------
// Context message builder
// ---------------------------------------------------------------------------

function buildContextMessage(text: string, ctx: RouterContext): string {
  const partsJson = ctx.parts.slice(0, 32).map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.position ? { position: p.position.map((v) => Number(v.toFixed(4))) } : {}),
    ...(p.bboxSize ? { bboxSize: p.bboxSize.map((v) => Number(v.toFixed(4))) } : {}),
  }));

  const context = {
    userText: text,
    sceneContext: {
      cadFileName: ctx.cadFileName ?? null,
      partCount: ctx.parts.length,
      parts: partsJson,
      stepCount: ctx.stepCount ?? 0,
      currentStepId: ctx.currentStepId ?? null,
      selectionPartId: ctx.selectionPartId ?? null,
      multiSelectIds: ctx.multiSelectIds && ctx.multiSelectIds.length > 0 ? ctx.multiSelectIds : null,
      interactionMode: ctx.interactionMode ?? null,
      iteration: ctx.iteration ?? 1,
      ...(ctx.vlmMateCapture
        ? { vlmMateCapture: ctx.vlmMateCapture }
        : {}),
      ...(ctx.toolResults && ctx.toolResults.length > 0
        ? { recentToolResults: ctx.toolResults.slice(-3) }
        : {}),
    },
  };

  return JSON.stringify(context, null, 2);
}

// ---------------------------------------------------------------------------
// AgentRouterProvider
// ---------------------------------------------------------------------------

export const AgentRouterProvider: RouterProvider = {
  async route(text: string, ctx: RouterContext): Promise<RouterRoute> {
    if (!text.trim()) {
      return { toolCalls: [], replyText: '請先輸入你想做的事。' };
    }

    // Mock mode for tests
    const mockPath = process.env.AGENT_LLM_MOCK_PATH;
    if (mockPath) {
      const mockResult = await getMockResponse(text, mockPath);
      if (mockResult) {
        // Still resolve partName → partId even in mock mode
        return {
          ...mockResult,
          toolCalls: resolvePartRefs(
            mockResult.toolCalls.map((tc) => ({ ...tc, args: tc.args as Record<string, unknown> })),
            ctx.parts
          ),
        };
      }
      // No mock entry found — return a graceful fallback
      return {
        toolCalls: [],
        replyText: '（測試模式）找不到對應的 mock 回應。',
      };
    }

    // Load system prompt (cached after first call)
    let systemPrompt: string;
    try {
      systemPrompt = await buildSystemPrompt();
    } catch (err) {
      console.error('[agentProvider] Failed to build system prompt:', err);
      return { toolCalls: [], replyText: '系統提示載入失敗，請稍後再試。' };
    }

    // Build user message
    const userMessage = buildContextMessage(text, ctx);

    // Call LLM
    let raw: { replyText: string; toolCalls: unknown[] } | null;
    try {
      raw = await callAgentLlm(systemPrompt, userMessage);
    } catch (err) {
      console.error('[agentProvider] LLM call failed:', err);
      return { toolCalls: [], replyText: '推論失敗，請再試一次。' };
    }

    if (!raw) {
      return { toolCalls: [], replyText: '推論失敗，請再試一次。' };
    }

    // Validate response schema
    const parsed = AgentResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[agentProvider] Response schema validation failed:', parsed.error.message);
      return { toolCalls: [], replyText: '回應格式錯誤，請再試一次。' };
    }

    // Resolve partName → partId
    const resolvedToolCalls = resolvePartRefs(parsed.data.toolCalls, ctx.parts);

    return {
      toolCalls: resolvedToolCalls,
      replyText: parsed.data.replyText,
    };
  },
};
