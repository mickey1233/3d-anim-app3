import type { ToolCall } from '../../../shared/schema/index.js';

export type RouterContext = {
  parts: { id: string; name: string }[];
};

export type RouterProvider = {
  route: (text: string, ctx: RouterContext) => Promise<ToolCall[]>;
};
