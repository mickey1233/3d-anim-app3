import type { ToolCall } from '../../../shared/schema/index.js';

export type RouterToolResult = {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  iteration?: number;
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
};

export type RouterRoute = {
  toolCalls: ToolCall[];
  replyText?: string;
};

export type RouterProvider = {
  route: (text: string, ctx: RouterContext) => Promise<RouterRoute>;
};
