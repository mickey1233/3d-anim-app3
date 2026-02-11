import type { MCPToolArgs, MCPToolName, MCPToolResult } from '../../../shared/schema/mcpToolsV3';
import { v2Client } from './client';

export async function callMcpTool<T extends MCPToolName>(
  tool: T,
  args: MCPToolArgs<T>
): Promise<MCPToolResult<T>> {
  const result = await v2Client.request('mcp_tool_call', {
    tool,
    args,
  });
  return result as MCPToolResult<T>;
}

export function extractToolErrorMessage(result: { ok: boolean; error?: { message?: string; code?: string } }) {
  if (result.ok) return null;
  const code = result.error?.code ? `${result.error.code}: ` : '';
  return `${code}${result.error?.message || 'unknown tool error'}`;
}
