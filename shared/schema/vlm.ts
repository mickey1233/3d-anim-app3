import { z } from 'zod';

export const VlmMateInferenceCandidateSchema = z.object({
  candidate_index: z.number().int().nonnegative().optional(),
  candidate_key: z.string().optional(),
  source_part_ref: z.string().optional(),
  target_part_ref: z.string().optional(),
  source_face: z.string().optional(),
  target_face: z.string().optional(),
  source_method: z.string().optional(),
  target_method: z.string().optional(),
  mode: z.string().optional(),
  intent: z.string().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
});

export const VlmMateInferenceViewVoteSchema = z.object({
  view_name: z.string(),
  candidate_index: z.number().int().nonnegative().optional(),
  candidate_key: z.string().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
});

export const VlmMateInferenceDiagnosticsSchema = z
  .object({
    provider: z.string().optional(),
    repair_attempts: z.number().int().nonnegative().optional(),
    fallback_used: z.boolean().optional(),
    provider_error: z.string().optional(),
    view_vote_count: z.number().int().nonnegative().optional(),
    candidate_vote_options: z.number().int().nonnegative().optional(),
    view_consensus: z.number().optional(),
    view_agreement: z.number().optional(),
    consensus_candidate_index: z.number().int().nonnegative().optional(),
    consensus_candidate_key: z.string().optional(),
    selected_matches_consensus: z.boolean().optional(),
    candidate_selection_source: z.enum(['model', 'view_votes', 'none']).optional(),
    flags: z.array(z.string()).default([]),
  })
  .passthrough();

export const VlmMateInferenceSchema = VlmMateInferenceCandidateSchema.extend({
  selected_candidate_index: z.number().int().nonnegative().optional(),
  selected_candidate_key: z.string().optional(),
  abstain: z.boolean().optional(),
  action_description: z.string().optional(),
  reasoning: z.string().optional(),
  view_votes: z.array(VlmMateInferenceViewVoteSchema).default([]),
  alternatives: z.array(VlmMateInferenceCandidateSchema).default([]),
  diagnostics: VlmMateInferenceDiagnosticsSchema.optional(),
});

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
  mate_inference: VlmMateInferenceSchema.optional(),
});

export type VlmResult = z.infer<typeof VlmResultSchema>;
