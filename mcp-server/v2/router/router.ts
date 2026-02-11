import type { TraceEntry } from '../../../shared/schema/index.js';
import { randomUUID } from 'crypto';
import { executeTool } from '../tools/registry.js';
import { MockRouterProvider } from './mockProvider.js';
import type { RouterContext, RouterProvider } from './types.js';

export type RouterResult = {
  trace: TraceEntry;
  results: any[];
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
  const toolCalls = await provider.route(text, ctx);

  const results = [];
  for (const call of toolCalls) {
    const res = await executeTool(call);
    results.push(res);
  }

  const trace: TraceEntry = {
    id: randomUUID(),
    ts: Date.now(),
    source: 'llm',
    input: text,
    toolCalls,
    toolResults: results,
    ok: results.every((r: any) => r.ok !== false),
  };

  const replyText =
    toolCalls.length === 0
      ? '我還不確定要做什麼，可以試試 /help 或描述你要的操作。'
      : `已完成 ${toolCalls.length} 個動作。`;

  return { trace, results, replyText };
}
