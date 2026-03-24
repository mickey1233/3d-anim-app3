import type { ToolCall } from '../../../shared/schema/index.js';

export type RouterToolResult = {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  iteration?: number;
};

export type VlmMateCapture = {
  vlmInference: {
    mode: string;
    intent: string;
    method?: string;
    sourceFace?: string;
    targetFace?: string;
    sourcePart: string;
    targetPart: string;
    confidence: number;
    reasoning?: string;
  } | null;
  meetsThreshold: boolean;
};

export type RouterContext = {
  parts: {
    id: string;
    name: string;
    position?: [number, number, number];
    bboxSize?: [number, number, number];
  }[];
  groups?: {
    id: string;
    name: string;
    partIds: string[];
  }[];
  steps?: { id: string; index: number; label: string }[];
  cadFileName?: string | null;
  stepCount?: number;
  currentStepId?: string | null;
  selectionPartId?: string | null;
  interactionMode?: 'select' | 'move' | 'rotate' | 'mate';
  toolResults?: RouterToolResult[];
  iteration?: number;
  /** Injected by wsGateway when MATE_VLM_ENABLE=1: result of vlm.capture_for_mate. */
  vlmMateCapture?: VlmMateCapture | null;
};

/** Optional metadata attached by smartProvider to describe which layer handled the request. */
export type RouteMeta = {
  route: 'docs' | 'fast-model' | 'codex';
  category: string;
  confidence: number;
  reason: string;
  docsScore: number;
  docsMs: number;
  model?: string;
  fastMs?: number;
  codexMs?: number;
};

export type RouterRoute = {
  toolCalls: ToolCall[];
  replyText?: string;
  /** Populated by smartProvider; optional for all other providers. */
  routeMeta?: RouteMeta;
};

export type RouterProvider = {
  route: (text: string, ctx: RouterContext) => Promise<RouterRoute>;
};

export type AgentLlmConfig = {
  provider: 'gemini' | 'ollama' | 'claude' | 'openai';
  model?: string;
  timeoutMs?: number;
  apiKey?: string;
  baseUrl?: string;
};
