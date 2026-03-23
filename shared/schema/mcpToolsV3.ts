import { z } from 'zod';
import { VlmResultSchema } from './vlm.js';

export const MCP_TOOLSET_VERSION = '2026-02-v1' as const;

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const QuaternionSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export type Vec2 = z.infer<typeof Vec2Schema>;
export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quaternion = z.infer<typeof QuaternionSchema>;

export const NonEmptyStringSchema = z.string().trim().min(1);
export const SceneRevisionSchema = z.number().int().nonnegative();

export const SpaceSchema = z.enum(['world', 'local']);
export const InteractionModeSchema = z.enum(['select', 'move', 'rotate', 'mate']);
export const SelectionKindSchema = z.enum(['part', 'face', 'edge', 'axis', 'point']);
export const FaceIdSchema = z.enum(['top', 'bottom', 'left', 'right', 'front', 'back', 'center', 'picked']);
export const MateModeSchema = z.enum([
  'face_flush',
  'face_insert_arc',
  'edge_to_edge',
  'axis_to_axis',
  'point_to_point',
  'planar_slide',
  'hinge_revolute',
]);

export const AnchorMethodSchema = z.enum([
  'auto',
  'planar_cluster',
  'face_projection',
  'geometry_aabb',
  'object_aabb',
  'extreme_vertices',
  'obb_pca',
  'picked',
]);

export const TwistAxisSchema = z.enum(['x', 'y', 'z', 'normal', 'tangent', 'bitangent']);
export const TwistAxisSpaceSchema = z.enum(['world', 'source_face', 'target_face']);

export const PartRefSchema = z
  .object({
    partId: NonEmptyStringSchema.optional(),
    partName: NonEmptyStringSchema.optional(),
  })
  .refine((value) => Boolean(value.partId || value.partName), {
    message: 'partId or partName is required',
  });

export type PartRef = z.infer<typeof PartRefSchema>;

export const ResolvedPartSchema = z.object({
  partId: NonEmptyStringSchema,
  partName: NonEmptyStringSchema,
  confidence: z.number().min(0).max(1),
  autoCorrected: z.boolean().default(false),
  reason: z.string().optional(),
});

export const FrameSchema = z.object({
  origin: Vec3Schema,
  normal: Vec3Schema,
  tangent: Vec3Schema,
  bitangent: Vec3Schema,
});

export const BoundingBoxSchema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
  size: Vec3Schema,
  center: Vec3Schema,
  space: SpaceSchema,
});

export const PartTransformSchema = z.object({
  position: Vec3Schema,
  quaternion: QuaternionSchema,
  scale: Vec3Schema,
  space: SpaceSchema.default('world'),
});

export const FeatureRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('part'),
    part: PartRefSchema,
  }),
  z.object({
    kind: z.literal('face'),
    part: PartRefSchema,
    face: FaceIdSchema,
    method: AnchorMethodSchema.default('auto'),
  }),
  z.object({
    kind: z.literal('edge'),
    part: PartRefSchema,
    edgeId: NonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('axis'),
    part: PartRefSchema,
    axisId: NonEmptyStringSchema.optional(),
    axisVector: Vec3Schema.optional(),
  }),
  z.object({
    kind: z.literal('point'),
    part: PartRefSchema,
    pointId: NonEmptyStringSchema.optional(),
    point: Vec3Schema.optional(),
  }),
]);

export type FeatureRef = z.infer<typeof FeatureRefSchema>;

export const ResolvedFeatureRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('part'),
    part: ResolvedPartSchema,
  }),
  z.object({
    kind: z.literal('face'),
    part: ResolvedPartSchema,
    face: FaceIdSchema,
    methodRequested: AnchorMethodSchema,
    methodUsed: AnchorMethodSchema,
    fallbackUsed: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('edge'),
    part: ResolvedPartSchema,
    edgeId: NonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('axis'),
    part: ResolvedPartSchema,
    axisId: NonEmptyStringSchema.optional(),
    axisVector: Vec3Schema,
  }),
  z.object({
    kind: z.literal('point'),
    part: ResolvedPartSchema,
    pointId: NonEmptyStringSchema.optional(),
    point: Vec3Schema,
  }),
]);

export const SelectionSnapshotSchema = z.object({
  active: ResolvedFeatureRefSchema.nullable(),
  stack: z.array(ResolvedFeatureRefSchema).max(8).default([]),
});

export const ToolWarningSchema = z.object({
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
});

export const ToolErrorCodeSchema = z.enum([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'AMBIGUOUS_SELECTION',
  'MODE_CONFLICT',
  'UNSUPPORTED_OPERATION',
  'SOLVER_FAILED',
  'CONSTRAINT_VIOLATION',
  'PREVIEW_NOT_FOUND',
  'HISTORY_EMPTY',
  'SCENE_OUT_OF_SYNC',
  'INTERNAL_ERROR',
]);

export const SuggestedToolCallSchema = z.object({
  tool: NonEmptyStringSchema,
  args: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().optional(),
});

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: NonEmptyStringSchema,
  recoverable: z.boolean().default(true),
  detail: z.unknown().optional(),
  suggestedToolCalls: z.array(SuggestedToolCallSchema).default([]),
});

export const AutoFixSchema = z.object({
  type: z.enum(['auto_resolve_part', 'auto_flip_normal', 'auto_swap_source_target', 'auto_mode_fallback']),
  before: z.unknown(),
  after: z.unknown(),
  reason: NonEmptyStringSchema,
});

export const SolveDebugSchema = z.object({
  sourceFrame: FrameSchema.optional(),
  targetFrame: FrameSchema.optional(),
  rotationAxisWorld: Vec3Schema.optional(),
  rotationAngleDeg: z.number().optional(),
  twistAxisWorld: Vec3Schema.optional(),
  twistAngleDeg: z.number().optional(),
  translationWorld: Vec3Schema.optional(),
  pathType: z.enum(['line', 'arc', 'screw', 'none']).optional(),
  notes: z.array(z.string()).default([]),
});

export const TransformPlanStepSchema = z.object({
  index: z.number().int().nonnegative(),
  timeMs: z.number().nonnegative(),
  positionWorld: Vec3Schema,
  quaternionWorld: QuaternionSchema,
});

export const TransformPlanSchema = z.object({
  planId: NonEmptyStringSchema,
  operation: z.enum(['translate', 'rotate', 'align', 'mate', 'twist', 'both']),
  mode: MateModeSchema.optional(),
  source: ResolvedFeatureRefSchema,
  target: ResolvedFeatureRefSchema.optional(),
  pathType: z.enum(['line', 'arc', 'screw', 'none']),
  durationMs: z.number().positive(),
  steps: z.array(TransformPlanStepSchema).min(1),
  constraints: z
    .object({
      offset: z.number().optional(),
      clearance: z.number().optional(),
      flip: z.boolean().default(false),
      twistAngleDeg: z.number().optional(),
      limitAxes: z.array(TwistAxisSchema).default([]),
      enforceCollisionCheck: z.boolean().default(false),
    })
    .default({
      flip: false,
      limitAxes: [],
      enforceCollisionCheck: false,
    }),
  autoFixes: z.array(AutoFixSchema).default([]),
  debug: SolveDebugSchema.optional(),
});

export const PreviewStateSchema = z.object({
  previewId: NonEmptyStringSchema,
  planId: NonEmptyStringSchema,
  active: z.boolean(),
  scrubT: z.number().min(0).max(1).default(1),
});

export const UiSyncStateSchema = z.object({
  sceneRevision: SceneRevisionSchema,
  interactionMode: InteractionModeSchema,
  selection: SelectionSnapshotSchema,
  preview: PreviewStateSchema.nullable(),
  playback: z.object({
    running: z.boolean(),
    currentStepId: z.string().nullable(),
  }),
  history: z.object({
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    size: z.number().int().nonnegative(),
  }),
});

export const ViewStateSchema = z.object({
  environment: NonEmptyStringSchema,
  showGrid: z.boolean(),
  showAnchors: z.boolean(),
});

export const ToolMetaSchema = z.object({
  requestId: NonEmptyStringSchema.optional(),
  traceId: NonEmptyStringSchema.optional(),
  sceneRevision: SceneRevisionSchema.optional(),
});

export const ToolSuccessEnvelopeSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    ok: z.literal(true),
    sceneRevision: SceneRevisionSchema,
    data: dataSchema,
    warnings: z.array(ToolWarningSchema).default([]),
    debug: SolveDebugSchema.optional(),
  });

export const ToolErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  sceneRevision: SceneRevisionSchema.optional(),
  error: ToolErrorSchema,
  warnings: z.array(ToolWarningSchema).default([]),
});

export const makeToolResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.union([ToolSuccessEnvelopeSchema(dataSchema), ToolErrorEnvelopeSchema]);

const SelectionGetArgsSchema = z.object({});
const SelectionGetDataSchema = z.object({ selection: SelectionSnapshotSchema });

const SelectionSetArgsSchema = z.object({
  selection: FeatureRefSchema,
  replace: z.boolean().default(true),
  autoResolve: z.boolean().default(true),
});
const SelectionSetDataSchema = z.object({
  selection: SelectionSnapshotSchema,
  resolved: ResolvedFeatureRefSchema,
  autoFixes: z.array(AutoFixSchema).default([]),
});

const SelectionClearArgsSchema = z.object({
  scope: z.enum(['active', 'all']).default('all'),
});
const SelectionClearDataSchema = z.object({ selection: SelectionSnapshotSchema });

const QuerySceneStateArgsSchema = z.object({
  verbosity: z.enum(['summary', 'full']).default('summary'),
});
const QuerySceneStateDataSchema = z.object({
  sceneRevision: SceneRevisionSchema,
  parts: z.array(
    z.object({
      partId: NonEmptyStringSchema,
      name: NonEmptyStringSchema,
      transformWorld: PartTransformSchema,
      bboxWorld: BoundingBoxSchema,
    })
  ),
  selection: SelectionSnapshotSchema,
  interactionMode: InteractionModeSchema,
});

const QueryPartTransformArgsSchema = z.object({
  part: PartRefSchema,
  space: SpaceSchema.default('world'),
});
const QueryPartTransformDataSchema = z.object({
  part: ResolvedPartSchema,
  transform: PartTransformSchema,
});

const QueryFaceInfoArgsSchema = z.object({
  part: PartRefSchema,
  face: FaceIdSchema,
  method: AnchorMethodSchema.default('auto'),
});
const QueryFaceInfoDataSchema = z.object({
  part: ResolvedPartSchema,
  face: FaceIdSchema,
  frameWorld: FrameSchema,
  normalOutward: z.boolean(),
  methodRequested: AnchorMethodSchema,
  methodUsed: AnchorMethodSchema,
  fallbackUsed: z.boolean().default(false),
});

const QueryLocalFrameArgsSchema = z.object({
  feature: FeatureRefSchema,
  space: SpaceSchema.default('world'),
});
const QueryLocalFrameDataSchema = z.object({
  feature: ResolvedFeatureRefSchema,
  frame: FrameSchema,
});

const QueryBoundingBoxArgsSchema = z.object({
  part: PartRefSchema,
  space: SpaceSchema.default('world'),
});
const QueryBoundingBoxDataSchema = z.object({
  part: ResolvedPartSchema,
  boundingBox: BoundingBoxSchema,
});

const QueryListMateModesArgsSchema = z.object({
  sourceKind: SelectionKindSchema.optional(),
  targetKind: SelectionKindSchema.optional(),
});
const QueryListMateModesDataSchema = z.object({
  modes: z.array(
    z.object({
      mode: MateModeSchema,
      requiredSource: z.array(SelectionKindSchema),
      requiredTarget: z.array(SelectionKindSchema),
      pathType: z.enum(['line', 'arc', 'screw', 'none']),
      tunables: z.array(NonEmptyStringSchema),
    })
  ),
});

const QueryModelInfoArgsSchema = z.object({
  verbosity: z.enum(['summary', 'detailed']).default('summary'),
});
const QueryModelInfoDataSchema = z.object({
  model: z.object({
    cadFileName: z.string().nullable(),
    cadUrl: z.string().nullable(),
    partCount: z.number().int().nonnegative(),
    partNames: z.array(NonEmptyStringSchema),
    stepCount: z.number().int().nonnegative(),
    currentStepId: z.string().nullable(),
    selectionPartId: z.string().nullable(),
    interactionMode: InteractionModeSchema,
    sceneBoundingBoxWorld: BoundingBoxSchema.nullable(),
  }),
});

const QueryMateSuggestionsArgsSchema = z.object({
  sourcePart: PartRefSchema,
  targetPart: PartRefSchema,
  instruction: z.string().optional(),
  preferredSourceFace: FaceIdSchema.optional(),
  preferredTargetFace: FaceIdSchema.optional(),
  sourceMethod: AnchorMethodSchema.default('auto'),
  targetMethod: AnchorMethodSchema.default('auto'),
  maxPairs: z.number().int().min(1).max(36).default(12),
});
const QueryMateSuggestionsDataSchema = z.object({
  source: ResolvedPartSchema,
  target: ResolvedPartSchema,
  intent: z.enum(['default', 'cover', 'insert']),
  suggestedMode: z.enum(['translate', 'twist', 'both']),
  expectedFromCenters: z.object({
    sourceFace: FaceIdSchema,
    targetFace: FaceIdSchema,
  }),
  sourceBoxWorld: BoundingBoxSchema,
  targetBoxWorld: BoundingBoxSchema,
  ranking: z.array(
    z.object({
      sourceFace: FaceIdSchema,
      targetFace: FaceIdSchema,
      sourceMethod: AnchorMethodSchema,
      targetMethod: AnchorMethodSchema,
      score: z.number(),
      facingScore: z.number(),
      approachScore: z.number(),
      distanceScore: z.number(),
      expectedFaceScore: z.number(),
    })
  ),
});

const QueryMateVlmInferArgsSchema = z.object({
  sourcePart: PartRefSchema,
  targetPart: PartRefSchema,
  instruction: z.string().default(''),
  preferredSourceFace: FaceIdSchema.optional(),
  preferredTargetFace: FaceIdSchema.optional(),
  sourceMethod: AnchorMethodSchema.default('auto'),
  targetMethod: AnchorMethodSchema.default('auto'),
  preferredMode: z.enum(['translate', 'twist', 'both']).optional(),
  maxPairs: z.number().int().min(1).max(36).default(12),
  maxViews: z.number().int().min(2).max(12).default(6),
  maxWidthPx: z.number().int().min(64).max(2048).default(960),
  maxHeightPx: z.number().int().min(64).max(2048).default(640),
  format: z.enum(['png', 'jpeg']).default('jpeg'),
});
const QueryMateVlmInferDataSchema = z.object({
  source: ResolvedPartSchema,
  target: ResolvedPartSchema,
  geometry: z.object({
    intent: z.enum(['default', 'cover', 'insert']),
    suggestedMode: z.enum(['translate', 'twist', 'both']),
    expectedFromCenters: z.object({
      sourceFace: FaceIdSchema,
      targetFace: FaceIdSchema,
    }),
    rankingTop: z
      .object({
        sourceFace: FaceIdSchema,
        targetFace: FaceIdSchema,
        sourceMethod: AnchorMethodSchema,
        targetMethod: AnchorMethodSchema,
        score: z.number(),
      })
      .nullable(),
  }),
  capture: z.object({
    imageCount: z.number().int().nonnegative(),
    views: z.array(
      z.object({
        name: NonEmptyStringSchema,
        label: NonEmptyStringSchema,
        widthPx: z.number().int().positive(),
        heightPx: z.number().int().positive(),
      })
    ),
  }),
  vlm: z.object({
    used: z.boolean(),
    provider: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    viewConsensus: z.number().min(0).max(1).optional(),
    viewAgreement: z.number().min(0).max(1).optional(),
    voteCount: z.number().int().nonnegative().optional(),
    consensusCandidateKey: z.string().optional(),
    diagnostics: z
      .object({
        provider: z.string().optional(),
        repairAttempts: z.number().int().nonnegative().optional(),
        fallbackUsed: z.boolean().optional(),
        providerError: z.string().optional(),
        candidateSelectionSource: z.enum(['model', 'view_votes', 'none']).optional(),
        selectedMatchesConsensus: z.boolean().optional(),
        flags: z.array(z.string()).default([]),
      })
      .optional(),
    viewVotes: z
      .array(
        z.object({
          viewName: NonEmptyStringSchema,
          candidateKey: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
          weight: z.number().nonnegative().optional(),
        })
      )
      .optional(),
    fallbackReason: z.string().optional(),
    mateInference: z
      .object({
        selectedCandidateIndex: z.number().int().nonnegative().optional(),
        sourcePartRef: z.string().optional(),
        targetPartRef: z.string().optional(),
        sourceFace: FaceIdSchema.optional(),
        targetFace: FaceIdSchema.optional(),
        sourceMethod: AnchorMethodSchema.optional(),
        targetMethod: AnchorMethodSchema.optional(),
        mode: z.enum(['translate', 'twist', 'both']).optional(),
        intent: z.enum(['default', 'cover', 'insert']).optional(),
        confidence: z.number().min(0).max(1).optional(),
        reason: z.string().optional(),
      })
      .optional(),
  }),
  inferred: z.object({
    sourcePartId: NonEmptyStringSchema,
    targetPartId: NonEmptyStringSchema,
    sourceFace: FaceIdSchema,
    targetFace: FaceIdSchema,
    sourceMethod: AnchorMethodSchema,
    targetMethod: AnchorMethodSchema,
    mode: z.enum(['translate', 'twist', 'both']),
    intent: z.enum(['default', 'cover', 'insert']),
    confidence: z.number().min(0).max(1),
    origin: z.enum(['geometry', 'vlm', 'hybrid']),
    arbitration: z.array(NonEmptyStringSchema).default([]),
    reason: z.string().optional(),
  }),
  notes: z.array(z.string()).default([]),
});

const WebSearchResultSchema = z.object({
  title: NonEmptyStringSchema,
  url: z.string().optional(),
  snippet: z.string().optional(),
});

const QueryWebSearchArgsSchema = z.object({
  query: NonEmptyStringSchema,
  maxResults: z.number().int().min(1).max(12).default(6),
  provider: z.enum(['duckduckgo']).default('duckduckgo'),
});
const QueryWebSearchDataSchema = z.object({
  provider: NonEmptyStringSchema,
  query: NonEmptyStringSchema,
  heading: z.string().optional(),
  abstract: z.string().optional(),
  abstractUrl: z.string().optional(),
  results: z.array(WebSearchResultSchema).default([]),
});

const QueryWeatherArgsSchema = z.object({
  location: NonEmptyStringSchema,
  days: z.number().int().min(1).max(7).default(1),
  units: z.enum(['metric', 'imperial']).default('metric'),
  language: z.string().optional(),
});
const QueryWeatherDataSchema = z.object({
  provider: z.literal('open-meteo'),
  requestedLocation: NonEmptyStringSchema,
  resolvedLocation: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().optional(),
  units: z.object({
    temperature: NonEmptyStringSchema,
    windSpeed: NonEmptyStringSchema,
    precipitation: NonEmptyStringSchema,
  }),
  current: z
    .object({
      time: z.string().optional(),
      temperature: z.number().optional(),
      windSpeed: z.number().optional(),
      windDirection: z.number().optional(),
      weatherCode: z.number().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  today: z
    .object({
      date: z.string().optional(),
      temperatureMax: z.number().optional(),
      temperatureMin: z.number().optional(),
      precipitationSum: z.number().optional(),
    })
    .optional(),
});

const ActionTranslateArgsSchema = z
  .object({
    part: PartRefSchema,
    delta: Vec3Schema.optional(),
    toPosition: Vec3Schema.optional(),
    space: SpaceSchema.default('world'),
    previewOnly: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.delta || value.toPosition), {
    message: 'delta or toPosition is required',
  });
const ActionTranslateDataSchema = z.object({
  part: ResolvedPartSchema,
  transform: PartTransformSchema,
  previewId: z.string().optional(),
});

const AxisRefSchema = z.object({
  axis: TwistAxisSchema,
  axisSpace: TwistAxisSpaceSchema.default('world'),
  customAxisWorld: Vec3Schema.optional(),
});

const ActionRotateArgsSchema = z.object({
  part: PartRefSchema,
  axis: AxisRefSchema,
  angleDeg: z.number(),
  pivotWorld: Vec3Schema.optional(),
  previewOnly: z.boolean().default(false),
});
const ActionRotateDataSchema = z.object({
  part: ResolvedPartSchema,
  transform: PartTransformSchema,
  appliedAngleDeg: z.number(),
  previewId: z.string().optional(),
});

const GeneratePlanArgsSchema = z.object({
  operation: z.enum(['translate', 'rotate', 'align', 'mate', 'twist', 'both']),
  source: FeatureRefSchema,
  target: FeatureRefSchema.optional(),
  sourceOffset: Vec3Schema.optional(),
  targetOffset: Vec3Schema.optional(),
  mateMode: MateModeSchema.optional(),
  pathPreference: z.enum(['auto', 'line', 'arc', 'screw']).default('auto'),
  durationMs: z.number().positive().default(900),
  sampleCount: z.number().int().min(2).max(240).default(60),
  flip: z.boolean().default(false),
  offset: z.number().default(0),
  clearance: z.number().default(0),
  twist: z
    .object({
      angleDeg: z.number().default(0),
      axis: TwistAxisSchema.default('normal'),
      axisSpace: TwistAxisSpaceSchema.default('target_face'),
      constraint: z.enum(['free', 'normal_only', 'world_axis_only']).default('free'),
    })
    .default({
      angleDeg: 0,
      axis: 'normal',
      axisSpace: 'target_face',
      constraint: 'free',
    }),
  arc: z
    .object({
      height: z.number().default(0),
      lateralBias: z.number().default(0),
    })
    .default({
      height: 0,
      lateralBias: 0,
    }),
  autoCorrectSelection: z.boolean().default(true),
  autoSwapSourceTarget: z.boolean().default(true),
  enforceNormalPolicy: z.enum(['none', 'source_out_target_in']).default('none'),
});
const GeneratePlanDataSchema = z.object({
  plan: TransformPlanSchema,
});

const ActionMateExecuteArgsSchema = z.object({
  sourcePart: PartRefSchema,
  targetPart: PartRefSchema,
  sourceGroupId: z.string().optional(),
  targetGroupId: z.string().optional(),
  sourceFace: FaceIdSchema.default('bottom'),
  targetFace: FaceIdSchema.default('top'),
  sourceMethod: AnchorMethodSchema.default('auto'),
  targetMethod: AnchorMethodSchema.default('auto'),
  sourceOffset: Vec3Schema.optional(),
  targetOffset: Vec3Schema.optional(),
  mode: z.enum(['translate', 'twist', 'both']).default('translate'),
  mateMode: MateModeSchema.optional(),
  pathPreference: z.enum(['auto', 'line', 'arc', 'screw']).default('auto'),
  durationMs: z.number().positive().default(900),
  sampleCount: z.number().int().min(2).max(240).default(60),
  flip: z.boolean().default(false),
  offset: z.number().default(0),
  clearance: z.number().default(0),
  twist: z
    .object({
      angleDeg: z.number().default(0),
      axis: TwistAxisSchema.default('normal'),
      axisSpace: TwistAxisSpaceSchema.default('target_face'),
      constraint: z.enum(['free', 'normal_only', 'world_axis_only']).default('free'),
    })
    .default({
      angleDeg: 0,
      axis: 'normal',
      axisSpace: 'target_face',
      constraint: 'free',
    }),
  arc: z
    .object({
      height: z.number().default(0),
      lateralBias: z.number().default(0),
    })
    .default({
      height: 0,
      lateralBias: 0,
    }),
  autoCorrectSelection: z.boolean().default(true),
  autoSwapSourceTarget: z.boolean().default(true),
  enforceNormalPolicy: z.enum(['none', 'source_out_target_in']).default('source_out_target_in'),
  commit: z.boolean().default(true),
  pushHistory: z.boolean().default(true),
  stepLabel: z.string().optional(),
});
const ActionMateExecuteDataSchema = z.object({
  source: ResolvedPartSchema,
  target: ResolvedPartSchema,
  plan: TransformPlanSchema,
  preview: PreviewStateSchema,
  committed: z.boolean(),
  historyId: z.string().optional(),
  transform: PartTransformSchema.optional(),
});

const ActionSmartMateExecuteArgsSchema = z.object({
  sourcePart: PartRefSchema,
  targetPart: PartRefSchema,
  sourceGroupId: z.string().optional(),
  targetGroupId: z.string().optional(),
  instruction: z.string().optional(),
  sourceFace: FaceIdSchema.optional(),
  targetFace: FaceIdSchema.optional(),
  sourceMethod: AnchorMethodSchema.optional(),
  targetMethod: AnchorMethodSchema.optional(),
  sourceOffset: Vec3Schema.optional(),
  targetOffset: Vec3Schema.optional(),
  mode: z.enum(['translate', 'twist', 'both']).optional(),
  mateMode: MateModeSchema.optional(),
  pathPreference: z.enum(['auto', 'line', 'arc', 'screw']).default('auto'),
  durationMs: z.number().positive().default(900),
  sampleCount: z.number().int().min(2).max(240).default(60),
  flip: z.boolean().default(false),
  offset: z.number().default(0),
  clearance: z.number().default(0),
  commit: z.boolean().default(true),
  pushHistory: z.boolean().default(true),
  stepLabel: z.string().optional(),
});
const ActionSmartMateExecuteDataSchema = z.object({
  source: ResolvedPartSchema,
  target: ResolvedPartSchema,
  chosen: z.object({
    sourceFace: FaceIdSchema,
    targetFace: FaceIdSchema,
    sourceMethod: AnchorMethodSchema,
    targetMethod: AnchorMethodSchema,
    mode: z.enum(['translate', 'twist', 'both']),
    mateMode: MateModeSchema,
    pathPreference: z.enum(['auto', 'line', 'arc', 'screw']),
  }),
  plan: TransformPlanSchema,
  preview: PreviewStateSchema,
  committed: z.boolean(),
  historyId: z.string().optional(),
  transform: PartTransformSchema.optional(),
});

const PreviewTransformPlanArgsSchema = z
  .object({
    planId: z.string().optional(),
    plan: TransformPlanSchema.optional(),
    replaceCurrent: z.boolean().default(true),
    scrubT: z.number().min(0).max(1).optional(),
  })
  .refine((value) => Boolean(value.planId || value.plan), {
    message: 'planId or plan is required',
  });
const PreviewTransformPlanDataSchema = z.object({
  preview: PreviewStateSchema,
});

const PreviewCancelArgsSchema = z.object({
  previewId: z.string().optional(),
});
const PreviewCancelDataSchema = z.object({
  canceled: z.boolean(),
  preview: PreviewStateSchema.nullable(),
});

const PreviewStatusArgsSchema = z.object({});
const PreviewStatusDataSchema = z.object({
  preview: PreviewStateSchema.nullable(),
});

const ActionCommitPreviewArgsSchema = z.object({
  previewId: NonEmptyStringSchema,
  stepLabel: z.string().optional(),
  pushHistory: z.boolean().default(true),
});
const ActionCommitPreviewDataSchema = z.object({
  committed: z.boolean(),
  previewId: NonEmptyStringSchema,
  historyId: z.string().optional(),
  transform: PartTransformSchema.optional(),
});

const HistoryUndoArgsSchema = z.object({});
const HistoryRedoArgsSchema = z.object({});
const HistoryResultDataSchema = z.object({
  historyId: z.string().optional(),
  selection: SelectionSnapshotSchema,
  preview: PreviewStateSchema.nullable(),
});

const ModeSetArgsSchema = z.object({
  mode: InteractionModeSchema,
  reason: z.string().optional(),
});
const ModeSetDataSchema = z.object({
  mode: InteractionModeSchema,
  changed: z.boolean(),
});

const UiGetSyncStateArgsSchema = z.object({});
const UiGetSyncStateDataSchema = z.object({ state: UiSyncStateSchema });

const ViewSetEnvironmentArgsSchema = z.object({
  environment: NonEmptyStringSchema,
});
const ViewSetEnvironmentDataSchema = z.object({ view: ViewStateSchema });

const ViewSetGridVisibleArgsSchema = z.object({
  visible: z.boolean(),
});
const ViewSetGridVisibleDataSchema = z.object({ view: ViewStateSchema });

const ViewSetAnchorsVisibleArgsSchema = z.object({
  visible: z.boolean(),
});
const ViewSetAnchorsVisibleDataSchema = z.object({ view: ViewStateSchema });

const ViewCaptureImageArgsSchema = z.object({
  maxWidthPx: z.number().int().min(64).max(2048).default(1024),
  maxHeightPx: z.number().int().min(64).max(2048).default(768),
  format: z.enum(['png', 'jpeg']).default('png'),
  jpegQuality: z.number().min(0.1).max(1).default(0.92),
});
const ViewCaptureImageDataSchema = z.object({
  image: z.object({
    dataUrl: NonEmptyStringSchema,
    mimeType: NonEmptyStringSchema,
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  }),
});

const PartsSetCadUrlArgsSchema = z.object({
  url: NonEmptyStringSchema,
  fileName: z.string().optional(),
});
const PartsSetCadUrlDataSchema = z.object({
  url: NonEmptyStringSchema,
  fileName: z.string().optional(),
  changed: z.boolean(),
});

const ActionSetPartTransformArgsSchema = z.object({
  part: PartRefSchema,
  transform: PartTransformSchema,
  previewOnly: z.boolean().default(false),
});
const ActionSetPartTransformDataSchema = z.object({
  part: ResolvedPartSchema,
  transform: PartTransformSchema,
  previewId: z.string().optional(),
});

const ActionResetPartArgsSchema = z.object({
  part: PartRefSchema,
});
const ActionResetPartDataSchema = z.object({
  part: ResolvedPartSchema,
  reset: z.boolean(),
  transform: PartTransformSchema.optional(),
});

const ActionResetPartTransformArgsSchema = z.object({
  part: PartRefSchema,
  mode: z.enum(['initial', 'manual']).default('initial'),
});
const ActionResetPartTransformDataSchema = z.object({
  part: ResolvedPartSchema,
  reset: z.boolean(),
  mode: z.enum(['initial', 'manual']),
  transform: PartTransformSchema.optional(),
  reason: z.string().optional(),
});

const ActionAutoAssembleArgsSchema = z.object({
  parts: z.array(PartRefSchema).optional(),
  basePart: PartRefSchema.optional(),
  instruction: z.string().optional(),
  maxSteps: z.number().int().min(1).max(20).optional(),
});
const ActionAutoAssembleDataSchema = z.object({
  totalSteps: z.number(),
  completedSteps: z.number(),
  steps: z.array(z.object({
    sourceName: z.string(),
    targetName: z.string(),
    instruction: z.string(),
    stepIndex: z.number(),
  })),
  reason: z.string().optional(),
});

const ActionResetAllArgsSchema = z.object({});
const ActionResetAllDataSchema = z.object({
  resetCount: z.number().int().nonnegative(),
});

const StepSummarySchema = z.object({
  stepId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
});

const StepsAddArgsSchema = z.object({
  label: NonEmptyStringSchema,
  select: z.boolean().default(true),
});
const StepsAddDataSchema = z.object({
  step: StepSummarySchema,
  steps: z.object({
    count: z.number().int().nonnegative(),
    currentStepId: z.string().nullable(),
  }),
});

const StepsSelectArgsSchema = z.object({
  stepId: NonEmptyStringSchema.nullable(),
});
const StepsSelectDataSchema = z.object({
  currentStepId: z.string().nullable(),
});

const StepsDeleteArgsSchema = z.object({
  stepId: NonEmptyStringSchema,
});
const StepsDeleteDataSchema = z.object({
  deleted: z.boolean(),
  stepId: NonEmptyStringSchema,
  steps: z.object({
    count: z.number().int().nonnegative(),
    currentStepId: z.string().nullable(),
  }),
});

const StepsInsertArgsSchema = z.object({
  afterStepId: z.string().nullable(),
  label: NonEmptyStringSchema,
  select: z.boolean().default(true),
});
const StepsInsertDataSchema = z.object({
  step: StepSummarySchema,
  steps: z.object({
    count: z.number().int().nonnegative(),
    currentStepId: z.string().nullable(),
  }),
});

const StepsMoveArgsSchema = z.object({
  stepId: NonEmptyStringSchema,
  targetStepId: NonEmptyStringSchema,
  position: z.enum(['before', 'after']).default('before'),
});
const StepsMoveDataSchema = z.object({
  moved: z.boolean(),
  order: z.array(NonEmptyStringSchema),
});

const StepsUpdateSnapshotArgsSchema = z.object({
  stepId: NonEmptyStringSchema,
});
const StepsUpdateSnapshotDataSchema = z.object({
  updated: z.boolean(),
  stepId: NonEmptyStringSchema,
});

const StepsPlaybackStartArgsSchema = z.object({
  durationMs: z.number().positive().optional(),
});
const StepsPlaybackStartDataSchema = z.object({
  running: z.boolean(),
});

const StepsPlaybackStartAtArgsSchema = z.object({
  stepId: NonEmptyStringSchema,
  durationMs: z.number().positive().optional(),
});
const StepsPlaybackStartAtDataSchema = z.object({
  running: z.boolean(),
  targetStepId: z.string(),
});

const StepsPlaybackStopArgsSchema = z.object({});
const StepsPlaybackStopDataSchema = z.object({
  running: z.boolean(),
});

const VlmImageInputSchema = z.object({
  name: NonEmptyStringSchema,
  mime: z.string().default('image/png'),
  dataBase64: NonEmptyStringSchema,
});

const VlmImageSummarySchema = z.object({
  imageId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
});

const VlmAddImagesArgsSchema = z.object({
  images: z.array(VlmImageInputSchema).min(1),
});
const VlmAddImagesDataSchema = z.object({
  added: z.array(VlmImageSummarySchema),
  count: z.number().int().nonnegative(),
});

const VlmMoveImageArgsSchema = z.object({
  imageId: NonEmptyStringSchema,
  delta: z.number().int().min(-1).max(1),
});
const VlmMoveImageDataSchema = z.object({
  moved: z.boolean(),
  count: z.number().int().nonnegative(),
});

const VlmRemoveImageArgsSchema = z.object({
  imageId: NonEmptyStringSchema,
});
const VlmRemoveImageDataSchema = z.object({
  removed: z.boolean(),
  count: z.number().int().nonnegative(),
});

const VlmAnalyzeArgsSchema = z.object({
  imageIds: z.array(NonEmptyStringSchema).optional(),
});
const VlmAnalyzeDataSchema = z.object({
  analyzing: z.boolean(),
  result: VlmResultSchema.optional(),
});

const CameraStateSchema = z.object({
  positionWorld: Vec3Schema,
  targetWorld: Vec3Schema,
  upWorld: Vec3Schema,
  fovDeg: z.number(),
  viewportPx: Vec2Schema,
});

const RotateDragBeginArgsSchema = z.object({
  part: PartRefSchema,
  pointerNdc: Vec2Schema,
  camera: CameraStateSchema,
  strategy: z.enum(['arcball', 'trackball', 'gizmo']).default('arcball'),
});

const RotateDragUpdateArgsSchema = z.object({
  sessionId: NonEmptyStringSchema,
  pointerNdc: Vec2Schema,
  camera: CameraStateSchema,
  snapDeg: z.number().positive().optional(),
});

const RotateDragEndArgsSchema = z.object({
  sessionId: NonEmptyStringSchema,
  commit: z.boolean().default(true),
});

const RotateDragDataSchema = z.object({
  sessionId: NonEmptyStringSchema,
  part: ResolvedPartSchema,
  preview: PreviewStateSchema,
  transform: PartTransformSchema,
});

const RotateDragEndDataSchema = z.object({
  sessionId: NonEmptyStringSchema,
  committed: z.boolean(),
  historyId: z.string().optional(),
});

const GizmoKindSchema = z.enum(['translate', 'rotate']);

const GizmoDragBeginArgsSchema = z.object({
  part: PartRefSchema,
  kind: GizmoKindSchema,
});

const GizmoDragUpdateArgsSchema = z.object({
  sessionId: NonEmptyStringSchema,
  transformWorld: PartTransformSchema,
});

const GizmoDragEndArgsSchema = z.object({
  sessionId: NonEmptyStringSchema,
  commit: z.boolean().default(true),
});

const GizmoDragDataSchema = z.object({
  sessionId: NonEmptyStringSchema,
  part: ResolvedPartSchema,
  kind: GizmoKindSchema,
  preview: PreviewStateSchema,
  transform: PartTransformSchema,
});

const GizmoDragEndDataSchema = z.object({
  sessionId: NonEmptyStringSchema,
  committed: z.boolean(),
  historyId: z.string().optional(),
});

export const MCPToolSchemas = {
  'selection.get': {
    args: SelectionGetArgsSchema,
    result: makeToolResultSchema(SelectionGetDataSchema),
  },
  'selection.set': {
    args: SelectionSetArgsSchema,
    result: makeToolResultSchema(SelectionSetDataSchema),
  },
  'selection.clear': {
    args: SelectionClearArgsSchema,
    result: makeToolResultSchema(SelectionClearDataSchema),
  },
  'query.scene_state': {
    args: QuerySceneStateArgsSchema,
    result: makeToolResultSchema(QuerySceneStateDataSchema),
  },
  'query.part_transform': {
    args: QueryPartTransformArgsSchema,
    result: makeToolResultSchema(QueryPartTransformDataSchema),
  },
  'query.face_info': {
    args: QueryFaceInfoArgsSchema,
    result: makeToolResultSchema(QueryFaceInfoDataSchema),
  },
  'query.local_frame': {
    args: QueryLocalFrameArgsSchema,
    result: makeToolResultSchema(QueryLocalFrameDataSchema),
  },
  'query.bounding_box': {
    args: QueryBoundingBoxArgsSchema,
    result: makeToolResultSchema(QueryBoundingBoxDataSchema),
  },
  'query.list_mate_modes': {
    args: QueryListMateModesArgsSchema,
    result: makeToolResultSchema(QueryListMateModesDataSchema),
  },
  'query.model_info': {
    args: QueryModelInfoArgsSchema,
    result: makeToolResultSchema(QueryModelInfoDataSchema),
  },
  'query.mate_suggestions': {
    args: QueryMateSuggestionsArgsSchema,
    result: makeToolResultSchema(QueryMateSuggestionsDataSchema),
  },
  'query.mate_vlm_infer': {
    args: QueryMateVlmInferArgsSchema,
    result: makeToolResultSchema(QueryMateVlmInferDataSchema),
  },
  'query.web_search': {
    args: QueryWebSearchArgsSchema,
    result: makeToolResultSchema(QueryWebSearchDataSchema),
  },
  'query.weather': {
    args: QueryWeatherArgsSchema,
    result: makeToolResultSchema(QueryWeatherDataSchema),
  },
  'view.set_environment': {
    args: ViewSetEnvironmentArgsSchema,
    result: makeToolResultSchema(ViewSetEnvironmentDataSchema),
  },
  'view.set_grid_visible': {
    args: ViewSetGridVisibleArgsSchema,
    result: makeToolResultSchema(ViewSetGridVisibleDataSchema),
  },
  'view.set_anchors_visible': {
    args: ViewSetAnchorsVisibleArgsSchema,
    result: makeToolResultSchema(ViewSetAnchorsVisibleDataSchema),
  },
  'view.capture_image': {
    args: ViewCaptureImageArgsSchema,
    result: makeToolResultSchema(ViewCaptureImageDataSchema),
  },
  'parts.set_cad_url': {
    args: PartsSetCadUrlArgsSchema,
    result: makeToolResultSchema(PartsSetCadUrlDataSchema),
  },
  'action.translate': {
    args: ActionTranslateArgsSchema,
    result: makeToolResultSchema(ActionTranslateDataSchema),
  },
  'action.rotate': {
    args: ActionRotateArgsSchema,
    result: makeToolResultSchema(ActionRotateDataSchema),
  },
  'action.set_part_transform': {
    args: ActionSetPartTransformArgsSchema,
    result: makeToolResultSchema(ActionSetPartTransformDataSchema),
  },
  'action.reset_part': {
    args: ActionResetPartArgsSchema,
    result: makeToolResultSchema(ActionResetPartDataSchema),
  },
  'action.reset_all': {
    args: ActionResetAllArgsSchema,
    result: makeToolResultSchema(ActionResetAllDataSchema),
  },
  'action.reset_part_transform': {
    args: ActionResetPartTransformArgsSchema,
    result: makeToolResultSchema(ActionResetPartTransformDataSchema),
  },
  'action.auto_assemble': {
    args: ActionAutoAssembleArgsSchema,
    result: makeToolResultSchema(ActionAutoAssembleDataSchema),
  },
  'action.generate_transform_plan': {
    args: GeneratePlanArgsSchema,
    result: makeToolResultSchema(GeneratePlanDataSchema),
  },
  'action.mate_execute': {
    args: ActionMateExecuteArgsSchema,
    result: makeToolResultSchema(ActionMateExecuteDataSchema),
  },
  'action.smart_mate_execute': {
    args: ActionSmartMateExecuteArgsSchema,
    result: makeToolResultSchema(ActionSmartMateExecuteDataSchema),
  },
  'preview.transform_plan': {
    args: PreviewTransformPlanArgsSchema,
    result: makeToolResultSchema(PreviewTransformPlanDataSchema),
  },
  'preview.cancel': {
    args: PreviewCancelArgsSchema,
    result: makeToolResultSchema(PreviewCancelDataSchema),
  },
  'preview.status': {
    args: PreviewStatusArgsSchema,
    result: makeToolResultSchema(PreviewStatusDataSchema),
  },
  'action.commit_preview': {
    args: ActionCommitPreviewArgsSchema,
    result: makeToolResultSchema(ActionCommitPreviewDataSchema),
  },
  'steps.add': {
    args: StepsAddArgsSchema,
    result: makeToolResultSchema(StepsAddDataSchema),
  },
  'steps.insert': {
    args: StepsInsertArgsSchema,
    result: makeToolResultSchema(StepsInsertDataSchema),
  },
  'steps.select': {
    args: StepsSelectArgsSchema,
    result: makeToolResultSchema(StepsSelectDataSchema),
  },
  'steps.delete': {
    args: StepsDeleteArgsSchema,
    result: makeToolResultSchema(StepsDeleteDataSchema),
  },
  'steps.move': {
    args: StepsMoveArgsSchema,
    result: makeToolResultSchema(StepsMoveDataSchema),
  },
  'steps.update_snapshot': {
    args: StepsUpdateSnapshotArgsSchema,
    result: makeToolResultSchema(StepsUpdateSnapshotDataSchema),
  },
  'steps.playback_start': {
    args: StepsPlaybackStartArgsSchema,
    result: makeToolResultSchema(StepsPlaybackStartDataSchema),
  },
  'steps.playback_start_at': {
    args: StepsPlaybackStartAtArgsSchema,
    result: makeToolResultSchema(StepsPlaybackStartAtDataSchema),
  },
  'steps.playback_stop': {
    args: StepsPlaybackStopArgsSchema,
    result: makeToolResultSchema(StepsPlaybackStopDataSchema),
  },
  'vlm.add_images': {
    args: VlmAddImagesArgsSchema,
    result: makeToolResultSchema(VlmAddImagesDataSchema),
  },
  'vlm.move_image': {
    args: VlmMoveImageArgsSchema,
    result: makeToolResultSchema(VlmMoveImageDataSchema),
  },
  'vlm.remove_image': {
    args: VlmRemoveImageArgsSchema,
    result: makeToolResultSchema(VlmRemoveImageDataSchema),
  },
  'vlm.analyze': {
    args: VlmAnalyzeArgsSchema,
    result: makeToolResultSchema(VlmAnalyzeDataSchema),
  },
  'history.undo': {
    args: HistoryUndoArgsSchema,
    result: makeToolResultSchema(HistoryResultDataSchema),
  },
  'history.redo': {
    args: HistoryRedoArgsSchema,
    result: makeToolResultSchema(HistoryResultDataSchema),
  },
  'mode.set_interaction_mode': {
    args: ModeSetArgsSchema,
    result: makeToolResultSchema(ModeSetDataSchema),
  },
  'ui.get_sync_state': {
    args: UiGetSyncStateArgsSchema,
    result: makeToolResultSchema(UiGetSyncStateDataSchema),
  },
  'interaction.rotate_drag_begin': {
    args: RotateDragBeginArgsSchema,
    result: makeToolResultSchema(RotateDragDataSchema),
  },
  'interaction.rotate_drag_update': {
    args: RotateDragUpdateArgsSchema,
    result: makeToolResultSchema(RotateDragDataSchema),
  },
  'interaction.rotate_drag_end': {
    args: RotateDragEndArgsSchema,
    result: makeToolResultSchema(RotateDragEndDataSchema),
  },
  'interaction.gizmo_drag_begin': {
    args: GizmoDragBeginArgsSchema,
    result: makeToolResultSchema(GizmoDragDataSchema),
  },
  'interaction.gizmo_drag_update': {
    args: GizmoDragUpdateArgsSchema,
    result: makeToolResultSchema(GizmoDragDataSchema),
  },
  'interaction.gizmo_drag_end': {
    args: GizmoDragEndArgsSchema,
    result: makeToolResultSchema(GizmoDragEndDataSchema),
  },
} as const;

export type MCPToolRegistry = typeof MCPToolSchemas;
export type MCPToolName = keyof MCPToolRegistry;

export const MCPToolNameSchema = z.enum([
  'selection.get',
  'selection.set',
  'selection.clear',
  'query.scene_state',
  'query.part_transform',
  'query.face_info',
  'query.local_frame',
  'query.bounding_box',
  'query.list_mate_modes',
  'query.model_info',
  'query.mate_suggestions',
  'query.mate_vlm_infer',
  'query.web_search',
  'query.weather',
  'view.set_environment',
  'view.set_grid_visible',
  'view.set_anchors_visible',
  'view.capture_image',
  'parts.set_cad_url',
  'action.translate',
  'action.rotate',
  'action.set_part_transform',
  'action.reset_part',
  'action.reset_all',
  'action.reset_part_transform',
  'action.auto_assemble',
  'action.generate_transform_plan',
  'action.mate_execute',
  'action.smart_mate_execute',
  'preview.transform_plan',
  'preview.cancel',
  'preview.status',
  'action.commit_preview',
  'steps.add',
  'steps.insert',
  'steps.select',
  'steps.delete',
  'steps.move',
  'steps.update_snapshot',
  'steps.playback_start',
  'steps.playback_start_at',
  'steps.playback_stop',
  'vlm.add_images',
  'vlm.move_image',
  'vlm.remove_image',
  'vlm.analyze',
  'history.undo',
  'history.redo',
  'mode.set_interaction_mode',
  'ui.get_sync_state',
  'interaction.rotate_drag_begin',
  'interaction.rotate_drag_update',
  'interaction.rotate_drag_end',
  'interaction.gizmo_drag_begin',
  'interaction.gizmo_drag_update',
  'interaction.gizmo_drag_end',
]);

const typedRequestSchemas = [
  z.object({ tool: z.literal('selection.get'), args: SelectionGetArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('selection.set'), args: SelectionSetArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('selection.clear'), args: SelectionClearArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.scene_state'), args: QuerySceneStateArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.part_transform'), args: QueryPartTransformArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.face_info'), args: QueryFaceInfoArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.local_frame'), args: QueryLocalFrameArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.bounding_box'), args: QueryBoundingBoxArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.list_mate_modes'), args: QueryListMateModesArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.model_info'), args: QueryModelInfoArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.mate_suggestions'), args: QueryMateSuggestionsArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.mate_vlm_infer'), args: QueryMateVlmInferArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.web_search'), args: QueryWebSearchArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('query.weather'), args: QueryWeatherArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('view.set_environment'), args: ViewSetEnvironmentArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('view.set_grid_visible'), args: ViewSetGridVisibleArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('view.set_anchors_visible'), args: ViewSetAnchorsVisibleArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('view.capture_image'), args: ViewCaptureImageArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('parts.set_cad_url'), args: PartsSetCadUrlArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.translate'), args: ActionTranslateArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.rotate'), args: ActionRotateArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.set_part_transform'), args: ActionSetPartTransformArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.reset_part'), args: ActionResetPartArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.reset_all'), args: ActionResetAllArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.reset_part_transform'), args: ActionResetPartTransformArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.auto_assemble'), args: ActionAutoAssembleArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.generate_transform_plan'), args: GeneratePlanArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.mate_execute'), args: ActionMateExecuteArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.smart_mate_execute'), args: ActionSmartMateExecuteArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('preview.transform_plan'), args: PreviewTransformPlanArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('preview.cancel'), args: PreviewCancelArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('preview.status'), args: PreviewStatusArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('action.commit_preview'), args: ActionCommitPreviewArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.add'), args: StepsAddArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.insert'), args: StepsInsertArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.select'), args: StepsSelectArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.delete'), args: StepsDeleteArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.move'), args: StepsMoveArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.update_snapshot'), args: StepsUpdateSnapshotArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.playback_start'), args: StepsPlaybackStartArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.playback_start_at'), args: StepsPlaybackStartAtArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('steps.playback_stop'), args: StepsPlaybackStopArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('vlm.add_images'), args: VlmAddImagesArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('vlm.move_image'), args: VlmMoveImageArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('vlm.remove_image'), args: VlmRemoveImageArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('vlm.analyze'), args: VlmAnalyzeArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('history.undo'), args: HistoryUndoArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('history.redo'), args: HistoryRedoArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('mode.set_interaction_mode'), args: ModeSetArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('ui.get_sync_state'), args: UiGetSyncStateArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('interaction.rotate_drag_begin'), args: RotateDragBeginArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('interaction.rotate_drag_update'), args: RotateDragUpdateArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('interaction.rotate_drag_end'), args: RotateDragEndArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('interaction.gizmo_drag_begin'), args: GizmoDragBeginArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('interaction.gizmo_drag_update'), args: GizmoDragUpdateArgsSchema, meta: ToolMetaSchema.optional() }),
  z.object({ tool: z.literal('interaction.gizmo_drag_end'), args: GizmoDragEndArgsSchema, meta: ToolMetaSchema.optional() }),
] as const;

export const MCPToolRequestSchema = z.discriminatedUnion('tool', typedRequestSchemas);

export type MCPToolRequest = z.infer<typeof MCPToolRequestSchema>;
export type MCPToolArgs<T extends MCPToolName> = z.input<MCPToolRegistry[T]['args']>;
export type MCPToolResult<T extends MCPToolName> = z.infer<MCPToolRegistry[T]['result']>;

export const MCPToolErrorCodes = ToolErrorCodeSchema.options;
