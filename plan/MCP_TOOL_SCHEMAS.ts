/**
 * 3D Animation Studio — MCP Tool Schemas
 *
 * This file contains:
 * 1. TypeScript interfaces for all tool inputs/outputs
 * 2. Zod validation schemas (runtime validation)
 * 3. MCP JSON Schema definitions (for tool registration)
 *
 * These schemas are SHARED between mcp-server and the React app.
 * Import from `shared/types.ts` in production.
 */

import { z } from 'zod';

// ============================================================
// SHARED PRIMITIVES
// ============================================================

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof QuatSchema>;

export const FaceDirection = z.enum([
  'top', 'bottom', 'left', 'right', 'front', 'back', 'center'
]);
export type FaceDirection = z.infer<typeof FaceDirection>;

export const MateMode = z.enum([
  'flush',           // face-to-face, normals opposing, surfaces touching
  'insert',          // face-to-face with arc path (cover/insert motion)
  'edge_to_edge',    // align edge intersection lines
  'axis_to_axis',    // cylindrical mate (align central axes)
  'point_to_point',  // coincide two points, no rotation
  'planar_slide',    // constrain to shared plane, free to slide
]);
export type MateMode = z.infer<typeof MateMode>;

export const InteractionMode = z.enum(['move', 'rotate', 'mate']);
export type InteractionMode = z.infer<typeof InteractionMode>;

export const EasingType = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);
export type EasingType = z.infer<typeof EasingType>;

// ── Face Frame ──
export const FaceFrameSchema = z.object({
  origin:    Vec3Schema.describe('World-space center of the face'),
  normal:    Vec3Schema.describe('Outward-facing normal (world)'),
  tangent:   Vec3Schema.describe('U direction on face plane (world)'),
  bitangent: Vec3Schema.describe('V direction on face plane (world)'),
});
export type FaceFrame = z.infer<typeof FaceFrameSchema>;

// ── Path Keyframe ──
export const PathKeyframeSchema = z.object({
  t:          z.number().min(0).max(1).describe('Normalized time [0,1]'),
  position:   Vec3Schema,
  quaternion: QuatSchema,
});
export type PathKeyframe = z.infer<typeof PathKeyframeSchema>;

// ── History Entry ──
export const HistoryEntrySchema = z.object({
  id:          z.string(),
  timestamp:   z.number(),
  description: z.string(),
  partUuid:    z.string(),
  before: z.object({
    position: Vec3Schema,
    rotation: Vec3Schema,
  }),
  after: z.object({
    position: Vec3Schema,
    rotation: Vec3Schema,
  }),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// ── Error Codes ──
export const ErrorCode = z.enum([
  'PART_NOT_FOUND',
  'FACE_NOT_FOUND',
  'NO_SELECTION',
  'PREVIEW_ACTIVE',
  'NO_PREVIEW',
  'INVALID_AXIS',
  'HISTORY_EMPTY',
  'ANIMATION_PLAYING',
  'APP_DISCONNECTED',
  'COMPUTE_FAILED',
  'SAME_PART',
  'NORMALS_SAME_DIRECTION',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;


// ============================================================
// TOOL 1: select_part
// ============================================================

export const SelectPartInputSchema = z.object({
  name_or_uuid: z.string().describe('Part name (fuzzy matched) or exact UUID'),
});
export type SelectPartInput = z.infer<typeof SelectPartInputSchema>;

export const SelectPartOutputSchema = z.object({
  success: z.boolean(),
  selected: z.object({
    uuid: z.string(),
    name: z.string(),
    position: Vec3Schema,
    rotation: Vec3Schema,
  }).nullable(),
  fuzzy_matched: z.boolean().optional().describe('True if name was fuzzy-matched'),
  original_query: z.string().optional(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type SelectPartOutput = z.infer<typeof SelectPartOutputSchema>;


// ============================================================
// TOOL 2: select_face
// ============================================================

export const SelectFaceInputSchema = z.object({
  part: z.string().describe('Part name or UUID'),
  face: FaceDirection.describe('Semantic face direction'),
});
export type SelectFaceInput = z.infer<typeof SelectFaceInputSchema>;

export const SelectFaceOutputSchema = z.object({
  success: z.boolean(),
  face_frame: FaceFrameSchema.optional(),
  face_bounds: z.object({
    width: z.number(),
    height: z.number(),
  }).optional(),
  part_uuid: z.string().optional(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type SelectFaceOutput = z.infer<typeof SelectFaceOutputSchema>;


// ============================================================
// TOOL 3: get_selection
// ============================================================

export const GetSelectionOutputSchema = z.object({
  selected_part: z.object({
    uuid: z.string(),
    name: z.string(),
  }).nullable(),
  selected_faces: z.array(z.object({
    part_uuid: z.string(),
    face: FaceDirection,
    face_frame: FaceFrameSchema,
  })),
  interaction_mode: InteractionMode,
});
export type GetSelectionOutput = z.infer<typeof GetSelectionOutputSchema>;


// ============================================================
// TOOL 4: get_scene_state
// ============================================================

export const ScenePartInfoSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  position: Vec3Schema,
  rotation: Vec3Schema,
  scale: Vec3Schema,
  bounding_box: z.object({
    min: Vec3Schema,
    max: Vec3Schema,
    size: Vec3Schema,
    center: Vec3Schema,
  }),
  color: z.string(),
});
export type ScenePartInfo = z.infer<typeof ScenePartInfoSchema>;

export const GetSceneStateOutputSchema = z.object({
  parts: z.array(ScenePartInfoSchema),
  camera: z.object({
    position: Vec3Schema,
    target: Vec3Schema,
  }),
  interaction_mode: InteractionMode,
  preview_active: z.boolean(),
  animation_playing: z.boolean(),
});
export type GetSceneStateOutput = z.infer<typeof GetSceneStateOutputSchema>;


// ============================================================
// TOOL 5: get_face_info
// ============================================================

export const GetFaceInfoInputSchema = z.object({
  part: z.string().describe('Part name or UUID'),
  face: FaceDirection,
});
export type GetFaceInfoInput = z.infer<typeof GetFaceInfoInputSchema>;

export const GetFaceInfoOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  part_name: z.string(),
  face: FaceDirection,
  frame: FaceFrameSchema,
  bounds: z.object({ width: z.number(), height: z.number() }),
  available_mate_modes: z.array(MateMode),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type GetFaceInfoOutput = z.infer<typeof GetFaceInfoOutputSchema>;


// ============================================================
// TOOL 6: get_part_transform
// ============================================================

export const GetPartTransformInputSchema = z.object({
  part: z.string().describe('Part name or UUID'),
});

export const GetPartTransformOutputSchema = z.object({
  success: z.boolean(),
  uuid: z.string(),
  name: z.string(),
  position: Vec3Schema,
  rotation: Vec3Schema,
  scale: Vec3Schema,
  quaternion: QuatSchema,
  world_matrix: z.array(z.number()).length(16).describe('Column-major 4x4 matrix'),
  bounding_box: z.object({
    min: Vec3Schema,
    max: Vec3Schema,
    size: Vec3Schema,
    center: Vec3Schema,
  }),
  error: z.string().optional(),
});


// ============================================================
// TOOL 7: translate_part
// ============================================================

export const TranslatePartInputSchema = z.object({
  part:    z.string().describe('Part name or UUID'),
  mode:    z.enum(['absolute', 'relative']).default('relative'),
  x:       z.number(),
  y:       z.number(),
  z:       z.number(),
  preview: z.boolean().default(false),
});
export type TranslatePartInput = z.infer<typeof TranslatePartInputSchema>;

export const TranslatePartOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  new_position: Vec3Schema,
  was_preview: z.boolean(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type TranslatePartOutput = z.infer<typeof TranslatePartOutputSchema>;


// ============================================================
// TOOL 8: rotate_part
// ============================================================

export const AxisSchema = z.union([
  z.enum(['x', 'y', 'z']),
  Vec3Schema.describe('Arbitrary axis as [nx, ny, nz]'),
]);

export const RotatePartInputSchema = z.object({
  part:     z.string(),
  axis:     AxisSchema,
  angle:    z.number().describe('Angle in degrees'),
  pivot:    Vec3Schema.optional().describe('Pivot point in world space'),
  absolute: z.boolean().default(false).describe('If true, set Euler directly'),
  preview:  z.boolean().default(false),
});
export type RotatePartInput = z.infer<typeof RotatePartInputSchema>;

export const RotatePartOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  new_rotation: Vec3Schema.describe('Euler XYZ in radians'),
  new_quaternion: QuatSchema,
  was_preview: z.boolean(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type RotatePartOutput = z.infer<typeof RotatePartOutputSchema>;


// ============================================================
// TOOL 9: align_faces (Core Mate Operation)
// ============================================================

export const AlignFacesInputSchema = z.object({
  source_part: z.string(),
  source_face: FaceDirection,
  target_part: z.string(),
  target_face: FaceDirection,
  mode:        MateMode,
  offset:      z.number().default(0).describe('Normal offset distance (gap)'),
  flip:        z.boolean().default(false).describe('Flip source normal 180°'),
  twist_angle: z.number().default(0).describe('Extra twist degrees around aligned normal'),
  preview:     z.boolean().default(false),
});
export type AlignFacesInput = z.infer<typeof AlignFacesInputSchema>;

export const AlignFacesOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  result_position: Vec3Schema,
  result_quaternion: QuatSchema,
  was_preview: z.boolean(),
  /** Arc path for insert mode */
  path: z.array(PathKeyframeSchema).optional(),
  debug: z.object({
    source_frame: FaceFrameSchema,
    target_frame: FaceFrameSchema,
    rotation_axis: Vec3Schema,
    rotation_angle_deg: z.number(),
    translation_vector: Vec3Schema,
    flip_applied: z.boolean(),
    twist_applied_deg: z.number(),
  }).optional(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type AlignFacesOutput = z.infer<typeof AlignFacesOutputSchema>;


// ============================================================
// TOOL 10: compute_mate (Pure Computation, No Side Effects)
// ============================================================

export const ComputeMateInputSchema = z.object({
  source_part: z.string(),
  source_face: FaceDirection,
  target_part: z.string(),
  target_face: FaceDirection,
  mode:        MateMode,
  offset:      z.number().default(0),
  flip:        z.boolean().default(false),
  twist_angle: z.number().default(0),
});
export type ComputeMateInput = z.infer<typeof ComputeMateInputSchema>;

export const ComputeMateOutputSchema = z.object({
  success: z.boolean(),
  result_transform: z.object({
    position: Vec3Schema,
    quaternion: QuatSchema,
  }).optional(),
  path: z.array(PathKeyframeSchema).optional(),
  debug: z.object({
    source_frame: FaceFrameSchema,
    target_frame: FaceFrameSchema,
    rotation_quaternion: QuatSchema,
    translation_vector: Vec3Schema,
    twist_axis: Vec3Schema,
    twist_angle_deg: z.number(),
    normal_dot: z.number().describe('dot(srcNormal, tgtNormal): -1 means opposing (correct), +1 means same direction (error)'),
    auto_flipped: z.boolean(),
  }).optional(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type ComputeMateOutput = z.infer<typeof ComputeMateOutputSchema>;


// ============================================================
// TOOL 11: compute_twist
// ============================================================

export const ComputeTwistInputSchema = z.object({
  part:           z.string(),
  axis:           z.union([
    z.enum(['x', 'y', 'z', 'face_normal']),
    Vec3Schema,
  ]).optional().describe('Twist axis. Defaults to Y if omitted.'),
  angle:          z.number().optional().describe('Twist angle in degrees. Auto-aligns if omitted.'),
  reference_face: FaceDirection.optional().describe('For face_normal axis or auto-alignment'),
  snap_increment: z.number().default(0).describe('Snap to nearest increment (e.g., 90). 0=free.'),
});
export type ComputeTwistInput = z.infer<typeof ComputeTwistInputSchema>;

export const ComputeTwistOutputSchema = z.object({
  success: z.boolean(),
  result_quaternion: QuatSchema,
  computed_axis: Vec3Schema,
  computed_angle_deg: z.number(),
  snapped_angle_deg: z.number().optional(),
  debug: z.object({
    original_rotation: Vec3Schema,
    pivot_point: Vec3Schema,
    axis_source: z.string().describe('How the axis was determined'),
  }).optional(),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type ComputeTwistOutput = z.infer<typeof ComputeTwistOutputSchema>;


// ============================================================
// TOOL 12: preview_transform
// ============================================================

export const PreviewTransformInputSchema = z.object({
  part:       z.string(),
  position:   Vec3Schema.optional(),
  rotation:   Vec3Schema.optional().describe('Euler XYZ in radians'),
  quaternion: QuatSchema.optional().describe('Alternative to rotation'),
  path:       z.array(PathKeyframeSchema).optional().describe('Animated path for arc preview'),
  duration:   z.number().default(2.0).describe('Preview animation duration in seconds'),
});
export type PreviewTransformInput = z.infer<typeof PreviewTransformInputSchema>;

export const PreviewTransformOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  preview_id: z.string().describe('Unique preview session ID'),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type PreviewTransformOutput = z.infer<typeof PreviewTransformOutputSchema>;


// ============================================================
// TOOL 13: commit_transform
// ============================================================

export const CommitTransformInputSchema = z.object({
  part:             z.string(),
  position:         Vec3Schema.optional().describe('Override position (if no preview active)'),
  rotation:         Vec3Schema.optional(),
  quaternion:       QuatSchema.optional(),
  add_to_sequence:  z.boolean().default(false),
  step_description: z.string().optional(),
});
export type CommitTransformInput = z.infer<typeof CommitTransformInputSchema>;

export const CommitTransformOutputSchema = z.object({
  success: z.boolean(),
  part_uuid: z.string(),
  final_position: Vec3Schema,
  final_rotation: Vec3Schema,
  history_id: z.string().describe('ID of the undo history entry'),
  step_id: z.string().optional().describe('Animation step ID if added to sequence'),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type CommitTransformOutput = z.infer<typeof CommitTransformOutputSchema>;


// ============================================================
// TOOL 14: cancel_preview
// ============================================================

export const CancelPreviewInputSchema = z.object({
  part: z.string().optional().describe('Part to cancel preview for. Omit to cancel all.'),
});
export type CancelPreviewInput = z.infer<typeof CancelPreviewInputSchema>;

export const CancelPreviewOutputSchema = z.object({
  success: z.boolean(),
  cancelled_parts: z.array(z.string()),
  error: z.string().optional(),
});
export type CancelPreviewOutput = z.infer<typeof CancelPreviewOutputSchema>;


// ============================================================
// TOOL 15: undo / redo
// ============================================================

export const UndoRedoOutputSchema = z.object({
  success: z.boolean(),
  action: z.string().describe('Description of what was undone/redone'),
  part_uuid: z.string().optional(),
  remaining: z.number().describe('Items remaining in the stack'),
  error: z.string().optional(),
  error_code: ErrorCode.optional(),
});
export type UndoRedoOutput = z.infer<typeof UndoRedoOutputSchema>;


// ============================================================
// TOOL 16: set_interaction_mode
// ============================================================

export const SetInteractionModeInputSchema = z.object({
  mode: InteractionMode,
});
export type SetInteractionModeInput = z.infer<typeof SetInteractionModeInputSchema>;


// ============================================================
// TOOL 17: add_animation_step
// ============================================================

export const AddAnimationStepInputSchema = z.object({
  part:              z.string(),
  target_position:   Vec3Schema.optional(),
  target_quaternion: QuatSchema.optional(),
  duration:          z.number().default(2.0),
  easing:            EasingType.default('easeInOut'),
  path:              z.array(PathKeyframeSchema).optional(),
  description:       z.string(),
});
export type AddAnimationStepInput = z.infer<typeof AddAnimationStepInputSchema>;


// ============================================================
// TOOL 18: play_animation / stop_animation
// ============================================================

export const PlayAnimationInputSchema = z.object({
  mode:       z.enum(['sequence', 'single_step']).default('sequence'),
  step_index: z.number().optional(),
});
export type PlayAnimationInput = z.infer<typeof PlayAnimationInputSchema>;


// ============================================================
// TOOL 19: reset_scene / reset_part / load_model
// ============================================================

export const ResetPartInputSchema = z.object({
  part: z.string(),
});

export const LoadModelInputSchema = z.object({
  url:      z.string().describe('URL or path to model file'),
  filename: z.string().optional(),
});


// ============================================================
// TOOL 20: set_environment
// ============================================================

export const SetEnvironmentInputSchema = z.object({
  preset: z.enum([
    'warehouse', 'city', 'sunset', 'studio', 'night',
    'apartment', 'forest', 'dawn', 'lobby', 'park'
  ]).optional(),
  floor: z.enum(['grid', 'reflective', 'none']).optional(),
});
export type SetEnvironmentInput = z.infer<typeof SetEnvironmentInputSchema>;


// ============================================================
// TOOL 21: get_ui_state
// ============================================================

export const GetUiStateOutputSchema = z.object({
  interaction_mode: InteractionMode,
  preview_active: z.boolean(),
  preview_part: z.string().nullable(),
  animation_playing: z.boolean(),
  sequence_playing: z.boolean(),
  current_step_index: z.number(),
  total_steps: z.number(),
  ws_status: z.enum(['connected', 'connecting', 'disconnected']),
  undo_available: z.boolean(),
  redo_available: z.boolean(),
});
export type GetUiStateOutput = z.infer<typeof GetUiStateOutputSchema>;


// ============================================================
// MCP TOOL REGISTRY (for server registration)
// ============================================================

/**
 * Complete tool list for MCP server registration.
 * Each entry maps to the JSON Schema format required by the MCP SDK.
 */
export const MCP_TOOLS = [
  {
    name: 'select_part',
    description: 'Select a part by name (fuzzy match) or UUID. Returns selected part transform.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name_or_uuid: { type: 'string', description: 'Part name or UUID' },
      },
      required: ['name_or_uuid'],
    },
  },
  {
    name: 'select_face',
    description: 'Select a semantic face on a part. Returns face coordinate frame for mate operations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string', description: 'Part name or UUID' },
        face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
      },
      required: ['part', 'face'],
    },
  },
  {
    name: 'get_selection',
    description: 'Query current selection: selected part, faces, and interaction mode.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_scene_state',
    description: 'List all parts with transforms, bounding boxes, camera, and UI state.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_face_info',
    description: 'Get coordinate frame (origin, normal, tangent, bitangent) for a face. Also returns available mate modes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
      },
      required: ['part', 'face'],
    },
  },
  {
    name: 'get_part_transform',
    description: 'Get full transform (position, rotation, quaternion, world matrix, bbox) for a part.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
      },
      required: ['part'],
    },
  },
  {
    name: 'translate_part',
    description: 'Move a part. relative=add delta, absolute=set position. preview=true for non-destructive preview.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        mode: { type: 'string', enum: ['absolute', 'relative'], default: 'relative' },
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        preview: { type: 'boolean', default: false },
      },
      required: ['part', 'x', 'y', 'z'],
    },
  },
  {
    name: 'rotate_part',
    description: 'Rotate a part around an axis by angle (degrees). Supports pivot point and arbitrary axis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        axis: {
          oneOf: [
            { type: 'string', enum: ['x', 'y', 'z'] },
            { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          ],
        },
        angle: { type: 'number', description: 'Degrees' },
        pivot: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        absolute: { type: 'boolean', default: false },
        preview: { type: 'boolean', default: false },
      },
      required: ['part', 'axis', 'angle'],
    },
  },
  {
    name: 'align_faces',
    description: 'Core mate: align source face to target face. Supports flush, insert (arc path), edge, axis, point modes. Use preview=true to see result first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_part: { type: 'string' },
        source_face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
        target_part: { type: 'string' },
        target_face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
        mode: { type: 'string', enum: ['flush','insert','edge_to_edge','axis_to_axis','point_to_point','planar_slide'] },
        offset: { type: 'number', default: 0 },
        flip: { type: 'boolean', default: false },
        twist_angle: { type: 'number', default: 0 },
        preview: { type: 'boolean', default: false },
      },
      required: ['source_part', 'source_face', 'target_part', 'target_face', 'mode'],
    },
  },
  {
    name: 'compute_mate',
    description: 'Pure computation: calculate mate transform without applying it. Returns transform, debug info, and arc path for insert mode.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_part: { type: 'string' },
        source_face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
        target_part: { type: 'string' },
        target_face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
        mode: { type: 'string', enum: ['flush','insert','edge_to_edge','axis_to_axis','point_to_point','planar_slide'] },
        offset: { type: 'number', default: 0 },
        flip: { type: 'boolean', default: false },
        twist_angle: { type: 'number', default: 0 },
      },
      required: ['source_part', 'source_face', 'target_part', 'target_face', 'mode'],
    },
  },
  {
    name: 'compute_twist',
    description: 'Compute rotation (twist) for a part. Supports arbitrary angles, snap increments, auto-alignment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        axis: {
          oneOf: [
            { type: 'string', enum: ['x', 'y', 'z', 'face_normal'] },
            { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          ],
        },
        angle: { type: 'number', description: 'Degrees' },
        reference_face: { type: 'string', enum: ['top','bottom','left','right','front','back','center'] },
        snap_increment: { type: 'number', default: 0 },
      },
      required: ['part'],
    },
  },
  {
    name: 'preview_transform',
    description: 'Show a ghosted preview of a transform. Supports single pose or animated arc path. Call commit_transform to apply or cancel_preview to discard.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        quaternion: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        path: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              t: { type: 'number' },
              position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
              quaternion: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            },
            required: ['t', 'position', 'quaternion'],
          },
        },
        duration: { type: 'number', default: 2.0 },
      },
      required: ['part'],
    },
  },
  {
    name: 'commit_transform',
    description: 'Apply the previewed transform (or a direct transform). Pushes to undo history. Optionally adds as animation step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        quaternion: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        add_to_sequence: { type: 'boolean', default: false },
        step_description: { type: 'string' },
      },
      required: ['part'],
    },
  },
  {
    name: 'cancel_preview',
    description: 'Cancel active preview, restore original transform.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string', description: 'Omit to cancel all previews' },
      },
    },
  },
  {
    name: 'undo',
    description: 'Undo the last committed transform.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'redo',
    description: 'Redo the last undone transform.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'set_interaction_mode',
    description: "Set 3D interaction mode: 'move' (translate gizmo), 'rotate' (rotate gizmo), 'mate' (face-picking).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['move', 'rotate', 'mate'] },
      },
      required: ['mode'],
    },
  },
  {
    name: 'add_animation_step',
    description: 'Add an animation step to the assembly sequence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
        target_position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        target_quaternion: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        duration: { type: 'number', default: 2.0 },
        easing: { type: 'string', enum: ['linear', 'easeIn', 'easeOut', 'easeInOut'], default: 'easeInOut' },
        path: { type: 'array', items: { type: 'object' } },
        description: { type: 'string' },
      },
      required: ['part', 'description'],
    },
  },
  {
    name: 'play_animation',
    description: 'Play the assembly animation sequence or a single step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['sequence', 'single_step'], default: 'sequence' },
        step_index: { type: 'number' },
      },
    },
  },
  {
    name: 'stop_animation',
    description: 'Stop any currently playing animation.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'reset_scene',
    description: 'Reset all parts to initial positions. Clears selection, stops animation.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'reset_part',
    description: 'Reset a specific part to its initial position.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part: { type: 'string' },
      },
      required: ['part'],
    },
  },
  {
    name: 'load_model',
    description: 'Load a 3D model (GLB/GLTF/USD) into the scene.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_ui_state',
    description: 'Get current UI state: mode, preview, animation, connection, undo/redo availability.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'set_environment',
    description: 'Change 3D environment preset and floor style.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        preset: { type: 'string', enum: ['warehouse','city','sunset','studio','night','apartment','forest','dawn','lobby','park'] },
        floor: { type: 'string', enum: ['grid','reflective','none'] },
      },
    },
  },
] as const;
