import { z } from 'zod';

export const VlmResultSchema = z.object({
  steps: z
    .array(
      z.object({
        from_image: z.string(),
        to_image: z.string(),
        changes: z.array(z.string()),
        inferred_action: z.string(),
      })
    )
    .default([]),
  objects: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
        confidence: z.number().optional(),
      })
    )
    .default([]),
  mapping_candidates: z
    .array(
      z.object({
        label: z.string(),
        scene_part_names: z.array(z.string()),
        chosen: z.string(),
        confidence: z.number(),
      })
    )
    .default([]),
  assembly_command: z
    .object({
      source_label: z.string(),
      target_label: z.string(),
      source_face: z.string(),
      target_face: z.string(),
      mcp_text_command: z.string(),
    })
    .optional(),
});

export type VlmResult = z.infer<typeof VlmResultSchema>;

