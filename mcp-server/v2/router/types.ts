import type { ToolCall } from '../../../shared/schema/index.js';
import type { RecentReferent } from '../../../shared/schema/entityResolutionTypes.js';

// ---------------------------------------------------------------------------
// Pending intent — conversational clarification state
// ---------------------------------------------------------------------------

export type PendingIntentSlot = 'source' | 'target';

export type PendingIntent = {
  /** Which kind of operation was being attempted. */
  type: 'mate' | 'move';
  /** Slots that still need to be filled by the next user reply. */
  missingSlots: PendingIntentSlot[];
  /** Args accumulated so far (everything except the missing slots). */
  cachedArgs: Record<string, unknown>;
  /** Display names for re-wording the confirmation message. */
  cachedSourceDisplay?: string;
  cachedTargetDisplay?: string;
  /** The clarification question that was already asked. */
  promptText: string;
  /** Unix ms timestamp after which this intent expires and is ignored. */
  expiresAt: number;
};

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
  multiSelectIds?: string[];
  interactionMode?: 'select' | 'move' | 'rotate' | 'mate';
  toolResults?: RouterToolResult[];
  iteration?: number;
  /** Injected by wsGateway when MATE_VLM_ENABLE=1: result of vlm.capture_for_mate. */
  vlmMateCapture?: VlmMateCapture | null;
  /**
   * Recent entity referents from the frontend store.
   * Populated by the frontend (ChatPanel) and used by entityResolutionScorer
   * to resolve deictic pronouns like "它", "this", "them", "那個".
   */
  recentReferents?: {
    lastSource: RecentReferent | null;
    lastTarget: RecentReferent | null;
  } | null;
  /**
   * Pending clarification intent from the previous turn.
   * When present and not expired, the router fills the missing slot(s)
   * from the user's reply instead of starting a fresh routing pass.
   */
  pendingIntent?: PendingIntent | null;
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
  /**
   * When the router asked a clarification question, this carries the pending
   * intent so the frontend can send it back on the next turn.
   */
  pendingIntent?: PendingIntent | null;
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
