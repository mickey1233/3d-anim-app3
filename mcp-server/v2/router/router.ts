import type { ToolCall } from '../../../shared/schema/index.js';
import { MockRouterProvider } from './mockProvider.js';
import type { RouterContext, RouterProvider } from './types.js';

export type RouterResult = {
  toolCalls: ToolCall[];
  replyText?: string;
};

const getProvider = (): RouterProvider => {
  const provider = process.env.ROUTER_PROVIDER || 'mock';
  if (provider === 'mock') return MockRouterProvider;
  // Future: Gemini/Ollama providers
  return MockRouterProvider;
};

export async function routeAndExecute(text: string, ctx: RouterContext): Promise<RouterResult> {
  const provider = getProvider();
  const routed = await provider.route(text, ctx);
  return {
    toolCalls: routed.toolCalls,
    replyText:
      routed.replyText ??
      (routed.toolCalls.length === 0
        ? '我還不確定你要執行哪個功能。你可以直接說例如「把格線關掉」或「切到 rotate 模式」。'
        : `收到，我會執行 ${routed.toolCalls.length} 個動作。`),
  };
}
