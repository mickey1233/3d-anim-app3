import { z } from 'zod';
import type { ToolCall, ToolResult } from '../../../shared/schema/index.js';

type ToolHandler = (args: any) => Promise<any>;

export type ToolDef = {
  schema: z.ZodTypeAny;
  handler: ToolHandler;
};

export const toolRegistry: Record<string, ToolDef> = {
  select_part: {
    schema: z.object({ nameOrId: z.string() }),
    handler: async (args) => ({ ok: true, selected: args.nameOrId }),
  },
  mate_top_bottom: {
    schema: z.object({
      sourceId: z.string(),
      targetId: z.string(),
      sourceFace: z.enum(['top', 'bottom', 'left', 'right', 'front', 'back']).default('bottom'),
      targetFace: z.enum(['top', 'bottom', 'left', 'right', 'front', 'back']).default('top'),
      mode: z.enum(['translate', 'twist', 'both']).default('translate'),
      twistSpec: z
        .object({
          axisSpace: z.enum(['world', 'source_face', 'target_face']),
          axis: z.enum(['x', 'y', 'z', 'normal', 'tangent', 'bitangent']),
          angleDeg: z.number(),
        })
        .optional(),
      sourceMethod: z
        .enum(['auto', 'planar_cluster', 'geometry_aabb', 'object_aabb', 'extreme_vertices', 'obb_pca', 'picked'])
        .optional(),
      targetMethod: z
        .enum(['auto', 'planar_cluster', 'geometry_aabb', 'object_aabb', 'extreme_vertices', 'obb_pca', 'picked'])
        .optional(),
    }),
    handler: async (args) => ({ ok: true, mate: args }),
  },
  add_step: {
    schema: z.object({ label: z.string() }),
    handler: async (args) => ({ ok: true, step: args.label }),
  },
};

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  const def = toolRegistry[call.tool];
  if (!def) {
    return { tool: call.tool, ok: false, error: 'Unknown tool' };
  }
  const parsed = def.schema.safeParse(call.args);
  if (!parsed.success) {
    return { tool: call.tool, ok: false, error: 'Invalid tool args' };
  }
  try {
    const result = await def.handler(parsed.data);
    return { tool: call.tool, ok: true, result };
  } catch (e: any) {
    return { tool: call.tool, ok: false, error: e.message || 'Tool failed' };
  }
}
