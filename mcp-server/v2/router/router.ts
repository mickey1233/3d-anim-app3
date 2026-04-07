import type { ToolCall } from '../../../shared/schema/index.js';
import { AgentRouterProvider } from './agentProvider.js';
import { SmartRouterProvider } from './smartProvider.js';
import type { RouterContext, RouterProvider, RouteMeta } from './types.js';
import { tryCommandFirstRoute } from './commandFirstRouter.js';
import type { CommandFirstDiagnostics } from './commandFirstRouter.js';

export type RouterResult = {
  toolCalls: ToolCall[];
  replyText?: string;
  routeMeta?: RouteMeta;
  commandFirstDiagnostics?: CommandFirstDiagnostics;
};

const getProvider = (): RouterProvider => {
  const provider = (process.env.ROUTER_PROVIDER || 'agent').toLowerCase().trim();
  if (provider === 'smart') return SmartRouterProvider;
  if (provider === 'agent') return AgentRouterProvider;
  return AgentRouterProvider;
};

export async function routeAndExecute(text: string, ctx: RouterContext): Promise<RouterResult> {
  // --- Command-first fast path ---
  // If the utterance contains a clear assembly verb + resolvable entities,
  // execute directly without LLM inference.
  const commandFirst = await tryCommandFirstRoute(text, ctx);
  if (commandFirst.matched) {
    return {
      toolCalls: commandFirst.toolCalls,
      replyText: commandFirst.replyText,
      commandFirstDiagnostics: commandFirst.diagnostics,
    };
  }

  const provider = getProvider();
  const routed = await provider.route(text, ctx);
  return {
    toolCalls: routed.toolCalls,
    replyText:
      routed.replyText ??
      (routed.toolCalls.length === 0
        ? '我還不確定你要執行哪個功能。你可以直接說例如「把格線關掉」或「切到 rotate 模式」。'
        : `收到，我會執行 ${routed.toolCalls.length} 個動作。`),
    ...(routed.routeMeta ? { routeMeta: routed.routeMeta } : {}),
    commandFirstDiagnostics: commandFirst.diagnostics, // always include (matched=false diag)
  };
}
