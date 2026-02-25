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

export type RouterRoute = {
  toolCalls: ToolCall[];
  replyText?: string;
};

export type RouterProvider = {
  route: (text: string, ctx: RouterContext) => Promise<RouterRoute>;
};
