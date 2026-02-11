import { z } from 'zod';
import { MCPToolRequestSchema } from '../../../shared/schema/mcpToolsV3';
import { executeMcpToolRequest } from './mcpToolExecutor';
import { v2Client } from './client';

const ToolProxyInvokePayloadSchema = z.object({
  proxyId: z.string().min(1),
  request: MCPToolRequestSchema,
});

let bridgeRegistered = false;

export function registerToolProxyBridge() {
  if (bridgeRegistered) {
    return () => {};
  }

  bridgeRegistered = true;

  const unsubscribe = v2Client.on('tool_proxy_invoke', async (payload) => {
    const parsed = ToolProxyInvokePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      try {
        await v2Client.request('tool_proxy_result', {
          proxyId: payload?.proxyId || 'unknown',
          error: {
            message: 'Invalid tool proxy payload',
            code: 'INVALID_TOOL_PROXY_PAYLOAD',
            details: parsed.error.flatten(),
          },
        });
      } catch {
        // best effort error reporting
      }
      return;
    }

    const { proxyId, request } = parsed.data;
    try {
      const result = await executeMcpToolRequest(request);
      await v2Client.request('tool_proxy_result', { proxyId, result });
    } catch (error: any) {
      await v2Client.request('tool_proxy_result', {
        proxyId,
        error: {
          message: error?.message || 'Tool execution failed',
          code: 'TOOL_EXECUTION_FAILED',
        },
      });
    }
  });

  return () => {
    bridgeRegistered = false;
    unsubscribe?.();
  };
}
