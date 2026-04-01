import * as THREE from 'three';
import type {
  MCPToolRequest,
  MCPToolName,
  MCPToolArgs,
  PartRef,
  FeatureRef,
} from '../../../shared/schema/mcpToolsV3';
import { useV2Store, type FaceId as StoreFaceId, type InteractionMode, type PartTransform } from '../store/store';
import { ENVIRONMENT_PRESETS } from '../three/backgrounds/backgrounds';
import { v2Client } from './client';
import { getV2Camera, getV2ObjectByPartId, getV2Renderer, getV2Scene, getV2ViewportPx } from '../three/SceneRegistry';
import { computeCaptureSize, dataUrlFromPixels } from '../three/captureUtils';
import { captureMultiAngles, DEFAULT_ANGLES } from '../three/captureMultiAngle';
import { resolveAnchor } from '../three/mating/anchorMethods';
import { solveMateTopBottom, applyMateTransform } from '../three/mating/solver';
import { clusterPlanarFaces } from '../three/mating/faceClustering';
import { extractFeatures } from '../three/mating/featureExtractor';
import { generateMatingCandidates } from '../three/mating/featureMatcher';
import { solveAlignment } from '../three/mating/featureSolver';
import { scoreSolvers } from '../three/mating/solverScoring';
import type { MatingCandidate, DemonstrationPriorScore } from '../three/mating/featureTypes';
import { groundObjects } from '../three/grounding/objectGrounder';
import type { GroundingResult } from '../../../shared/schema/groundingTypes';
import { getAllCards, getCard, registerPartBasic, applyVlmLabel, clearRegistry, syncRegistryFromStore } from '../three/grounding/partSemanticRegistry';
import { planAssemblyConstraints, hasExplicitTargetInUtterance } from '../three/grounding/assemblyPlanner';
import { routeAssemblyIntent, applyRoutingAdjustments, detectFallbackUsed } from '../three/mating/intentRouter';

// ---------------------------------------------------------------------------
// Candidate registry — session-scoped, cleared on scene reset
// ---------------------------------------------------------------------------
/**
 * Stores full MatingCandidate[] keyed by "sourcePartId:targetPartId".
 * Cleared when the scene resets (resetRuntimeForNewScene).
 */
const candidateRegistry = new Map<string, MatingCandidate[]>();

function candidateRegistryKey(srcId: string, tgtId: string): string {
  // Canonical order so A:B and B:A find the same candidates (bidirectional lookup)
  const [a, b] = [srcId, tgtId].sort();
  return `${a}:${b}`;
}

// ---------------------------------------------------------------------------

type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_SELECTION'
  | 'MODE_CONFLICT'
  | 'UNSUPPORTED_OPERATION'
  | 'SOLVER_FAILED'
  | 'CONSTRAINT_VIOLATION'
  | 'PREVIEW_NOT_FOUND'
  | 'HISTORY_EMPTY'
  | 'SCENE_OUT_OF_SYNC'
  | 'INTERNAL_ERROR';

type ToolWarning = { code: string; message: string };

type ToolErrorShape = {
  code: ToolErrorCode;
  message: string;
  recoverable: boolean;
  detail?: unknown;
  suggestedToolCalls: Array<{ tool: string; args: Record<string, unknown>; reason?: string }>;
};

type ToolSuccess<T = unknown> = {
  ok: true;
  sceneRevision: number;
  data: T;
  warnings: ToolWarning[];
  debug?: unknown;
};

type ToolFailure = {
  ok: false;
  sceneRevision?: number;
  error: ToolErrorShape;
  warnings: ToolWarning[];
};

type ToolEnvelope<T = unknown> = ToolSuccess<T> | ToolFailure;

type ResolvedPart = {
  partId: string;
  partName: string;
  confidence: number;
  autoCorrected: boolean;
  reason?: string;
};

type ResolvedFeature =
  | {
      kind: 'part';
      part: ResolvedPart;
    }
  | {
      kind: 'face';
      part: ResolvedPart;
      face: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | 'center' | 'picked';
      methodRequested: 'auto' | 'planar_cluster' | 'geometry_aabb' | 'object_aabb' | 'extreme_vertices' | 'obb_pca' | 'picked';
      methodUsed: 'auto' | 'planar_cluster' | 'geometry_aabb' | 'object_aabb' | 'extreme_vertices' | 'obb_pca' | 'picked';
      fallbackUsed: boolean;
    }
  | {
      kind: 'edge';
      part: ResolvedPart;
      edgeId: string;
    }
  | {
      kind: 'axis';
      part: ResolvedPart;
      axisId?: string;
      axisVector: [number, number, number];
    }
  | {
      kind: 'point';
      part: ResolvedPart;
      pointId?: string;
      point: [number, number, number];
    };

type Frame = {
  origin: [number, number, number];
  normal: [number, number, number];
  tangent: [number, number, number];
  bitangent: [number, number, number];
};

type RuntimePreview = {
  previewId: string;
  planId: string;
  active: boolean;
  scrubT: number;
  partId: string;
};

type RuntimeRotateSession = {
  sessionId: string;
  part: ResolvedPart;
  startPointer: [number, number];
  startTransform: PartTransform;
  previewId: string;
};

type RuntimeState = {
  sceneRevision: number;
  interactionMode: InteractionMode;
  selection: {
    active: ResolvedFeature | null;
    stack: ResolvedFeature[];
  };
  plans: Map<string, any>;
  preview: RuntimePreview | null;
  previewBeforeTransformByPartId: Map<string, PartTransform>;
  rotateSessions: Map<string, RuntimeRotateSession>;
};

const runtimeState: RuntimeState = {
  sceneRevision: 0,
  interactionMode: 'move',
  selection: { active: null, stack: [] },
  plans: new Map(),
  preview: null,
  previewBeforeTransformByPartId: new Map(),
  rotateSessions: new Map(),
};

class ToolExecutionError extends Error {
  code: ToolErrorCode;
  recoverable: boolean;
  detail?: unknown;
  suggestedToolCalls: Array<{ tool: string; args: Record<string, unknown>; reason?: string }>;

  constructor(params: {
    code: ToolErrorCode;
    message: string;
    recoverable?: boolean;
    detail?: unknown;
    suggestedToolCalls?: Array<{ tool: string; args: Record<string, unknown>; reason?: string }>;
  }) {
    super(params.message);
    this.code = params.code;
    this.recoverable = params.recoverable ?? true;
    this.detail = params.detail;
    this.suggestedToolCalls = params.suggestedToolCalls ?? [];
  }
}

const ZERO3: [number, number, number] = [0, 0, 0];
const IDENTITY_Q: [number, number, number, number] = [0, 0, 0, 1];

const STORE_FACES: StoreFaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];

type MateExecMode = 'translate' | 'twist' | 'both';
type AnchorMethodId = 'auto' | 'planar_cluster' | 'geometry_aabb' | 'object_aabb' | 'extreme_vertices' | 'obb_pca' | 'picked';
type MateIntentKind = 'default' | 'cover' | 'insert' | 'twist_insert' | 'arc_cover';

const EXEC_ANCHOR_METHOD_IDS: AnchorMethodId[] = [
  'planar_cluster',
  'geometry_aabb',
  'object_aabb',
  'obb_pca',
  'picked',
];

function isExecutableAnchorMethod(value: unknown): value is AnchorMethodId {
  return typeof value === 'string' && EXEC_ANCHOR_METHOD_IDS.includes(value as AnchorMethodId);
}

function normalizeAnchorMethod(value: unknown, fallback: AnchorMethodId = 'planar_cluster'): AnchorMethodId {
  if (typeof value !== 'string') return fallback;
  const method = value.toLowerCase() as AnchorMethodId;
  if (method === 'auto' || method === 'extreme_vertices') return fallback;
  return isExecutableAnchorMethod(method) ? method : fallback;
}

function parseExplicitAnchorMethod(value: unknown): AnchorMethodId | null {
  if (typeof value !== 'string') return null;
  const method = value.toLowerCase() as AnchorMethodId;
  if (method === 'auto' || method === 'extreme_vertices') return null;
  return isExecutableAnchorMethod(method) ? method : null;
}

type FaceAnchorCandidate = {
  face: StoreFaceId;
  method: AnchorMethodId;
  centerWorld: THREE.Vector3;
  normalWorld: THREE.Vector3;
  areaHint: number;
};

type FacePairSuggestion = {
  sourceFace: StoreFaceId;
  targetFace: StoreFaceId;
  sourceMethod: AnchorMethodId;
  targetMethod: AnchorMethodId;
  score: number;
  ranking: Array<{
    sourceFace: StoreFaceId;
    targetFace: StoreFaceId;
    sourceMethod: AnchorMethodId;
    targetMethod: AnchorMethodId;
    score: number;
    facingScore: number;
    approachScore: number;
    distanceScore: number;
    expectedFaceScore: number;
  }>;
};

function parseOffsetTuple(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [0, 0, 0];
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0];
}

function normalizeInstructionText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function overlapRatio1D(
  firstMin: number,
  firstMax: number,
  secondMin: number,
  secondMax: number
) {
  const overlap = Math.max(0, Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin));
  const base = Math.max(1e-6, Math.min(firstMax - firstMin, secondMax - secondMin));
  return overlap / base;
}

function computeRootLocalBoundingBox(object: THREE.Object3D) {
  const box = new THREE.Box3().makeEmpty();
  object.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const localToRoot = new THREE.Matrix4();
  const transformedPoint = new THREE.Vector3();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.attributes?.position) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;

    localToRoot.multiplyMatrices(rootInv, mesh.matrixWorld);
    const { min, max } = geometry.boundingBox;
    corners[0].set(min.x, min.y, min.z);
    corners[1].set(max.x, min.y, min.z);
    corners[2].set(max.x, max.y, min.z);
    corners[3].set(min.x, max.y, min.z);
    corners[4].set(min.x, min.y, max.z);
    corners[5].set(max.x, min.y, max.z);
    corners[6].set(max.x, max.y, max.z);
    corners[7].set(min.x, max.y, max.z);
    for (const corner of corners) {
      transformedPoint.copy(corner).applyMatrix4(localToRoot);
      box.expandByPoint(transformedPoint);
    }
    localToRoot.identity();
  });

  return box;
}

// Compute a percentile-trimmed AABB in world space.
// Excludes the top/bottom `pct` fraction of vertex positions per axis, which removes
// thin mounting-face vertices (at Y≈0 in Spark GLBs) that inflate the bounding box.
function computeWorldPercentileBox(obj: THREE.Object3D, pct = 0.02): THREE.Box3 {
  obj.updateWorldMatrix(true, true);
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const v = new THREE.Vector3();
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count === 0) return;
    const stride = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  });
  if (xs.length === 0) return new THREE.Box3();
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const n = xs.length;
  const lo = Math.max(0, Math.round(n * pct));
  const hi = Math.min(n - 1, Math.round(n * (1 - pct)));
  return new THREE.Box3(
    new THREE.Vector3(xs[lo], ys[lo], zs[lo]),
    new THREE.Vector3(xs[hi], ys[hi], zs[hi]),
  );
}

function getIntrinsicSizeFromObject(object: THREE.Object3D) {
  const localBox = computeRootLocalBoundingBox(object);
  if (!localBox.isEmpty()) return localBox.getSize(new THREE.Vector3());
  const worldBox = new THREE.Box3().setFromObject(object);
  if (!worldBox.isEmpty()) return worldBox.getSize(new THREE.Vector3());
  return new THREE.Vector3(1e-3, 1e-3, 1e-3);
}

function getWorldCenterFromObject(object: THREE.Object3D) {
  const worldBox = new THREE.Box3().setFromObject(object);
  if (!worldBox.isEmpty()) return worldBox.getCenter(new THREE.Vector3());
  return object.getWorldPosition(new THREE.Vector3());
}

function inferIntentFromGeometry(sourceObject: THREE.Object3D, targetObject: THREE.Object3D): MateIntentKind | null {
  const sourceCenter = getWorldCenterFromObject(sourceObject);
  const targetCenter = getWorldCenterFromObject(targetObject);
  const sourceSize = getIntrinsicSizeFromObject(sourceObject);
  const targetSize = getIntrinsicSizeFromObject(targetObject);
  const delta = targetCenter.clone().sub(sourceCenter);

  const sourceVol = Math.max(1e-6, Math.abs(sourceSize.x * sourceSize.y * sourceSize.z));
  const targetVol = Math.max(1e-6, Math.abs(targetSize.x * targetSize.y * targetSize.z));
  const volumeRatio = targetVol / sourceVol;

  const srcDims = [Math.abs(sourceSize.x), Math.abs(sourceSize.y), Math.abs(sourceSize.z)].sort((a, b) => a - b);
  const tgtDims = [Math.abs(targetSize.x), Math.abs(targetSize.y), Math.abs(targetSize.z)].sort((a, b) => a - b);
  const fitStrictCount = srcDims.filter((value, index) => value <= tgtDims[index] * 0.9).length;
  const fitLooseCount = srcDims.filter((value, index) => value <= tgtDims[index] * 0.95).length;
  const centerDistance = delta.length();
  const targetCharacteristic = Math.max(1e-3, ...tgtDims);

  if (volumeRatio >= 1.55 && fitStrictCount >= 2) {
    return 'insert';
  }

  // Source dimensions all fit within target (looser tolerance) — position-independent check
  // (part may be far from target if user hasn't moved it yet)
  if (fitLooseCount >= 3 && volumeRatio >= 1.3) {
    return 'insert';
  }

  if (fitLooseCount >= 2 && centerDistance <= targetCharacteristic * 2.2) {
    return 'insert';
  }

  const stackedAlongY = Math.abs(delta.y) > (srcDims[1] + tgtDims[1]) * 0.22;
  const horizontalDist = Math.hypot(delta.x, delta.z);
  const horizontalAllowance = (srcDims[2] + tgtDims[2]) * 0.42;
  const closeInPlane = horizontalDist <= Math.max(1e-3, horizontalAllowance);
  if (stackedAlongY && closeInPlane) return 'cover';

  const pseudoOverlapX = overlapRatio1D(sourceCenter.x - srcDims[2] * 0.5, sourceCenter.x + srcDims[2] * 0.5, targetCenter.x - tgtDims[2] * 0.5, targetCenter.x + tgtDims[2] * 0.5);
  const pseudoOverlapZ = overlapRatio1D(sourceCenter.z - srcDims[2] * 0.5, sourceCenter.z + srcDims[2] * 0.5, targetCenter.z - tgtDims[2] * 0.5, targetCenter.z + tgtDims[2] * 0.5);
  const stackedAlongYWithOverlap = Math.abs(delta.y) > (srcDims[1] + tgtDims[1]) * 0.22 && pseudoOverlapX > 0.5 && pseudoOverlapZ > 0.5;
  if (stackedAlongYWithOverlap) return 'cover';

  if (stackedAlongY) return 'cover';

  return null;
}

function instructionIncludesAny(instruction: string, tokens: string[]) {
  return tokens.some((token) => instruction.includes(token));
}

/**
 * Parses explicit anchor method override from user instruction text.
 * Kept as a fast-path shortcut (no LLM call needed for explicit method names).
 */
function methodFromInstruction(instruction: string): AnchorMethodId | null {
  const table: Array<{ method: AnchorMethodId; tokens: string[] }> = [
    { method: 'object_aabb', tokens: ['object aabb', 'object_aabb', 'obj aabb', '对象aabb', '物件aabb'] },
    { method: 'geometry_aabb', tokens: ['geometry aabb', 'geometry_aabb', 'geo aabb', 'mesh aabb', '幾何aabb', '几何aabb'] },
    { method: 'planar_cluster', tokens: ['planar cluster', 'planar_cluster', '平面分群', '平面聚類', '平面聚类'] },
    { method: 'extreme_vertices', tokens: ['extreme vertices', 'extreme_vertices', '極值', '极值'] },
    { method: 'obb_pca', tokens: ['obb pca', 'obb', 'pca'] },
    { method: 'picked', tokens: ['picked', 'pick face', '手動選面', '手动选面'] },
    { method: 'auto', tokens: ['auto', '自動', '自动'] },
  ];
  for (const row of table) {
    if (instructionIncludesAny(instruction, row.tokens)) return row.method;
  }
  return null;
}

type AgentMateParams = {
  intent: MateIntentKind;
  mode: MateExecMode;
  sourceFace: StoreFaceId;
  targetFace: StoreFaceId;
  sourceMethod: AnchorMethodId;
  targetMethod: AnchorMethodId;
  confidence: number;
  reasoning?: string;
};

// Demo fast-path: in-memory cache for repeated source-target mate param results.
// Keyed by "sourceName|targetName" (canonical order — sorted alphabetically).
const _mateParamsCache = new Map<string, AgentMateParams>();
const DEMO_FAST_PATH = import.meta.env.VITE_DEMO_FAST_PATH === 'true';

function _mateParamsCacheKey(srcName: string, tgtName: string): string {
  return [srcName, tgtName].sort().join('|');
}

/**
 * Calls the backend agent.infer_mate_params WS command with geometry context.
 * Returns LLM-inferred assembly parameters, or null on failure.
 * When VITE_DEMO_FAST_PATH=true, skips LLM and returns null immediately so
 * geometry inference handles the decision (much faster for live demos).
 */
async function callAgentForMateParams(params: {
  userText: string;
  sourcePart: { id: string; name: string };
  targetPart: { id: string; name: string };
  geometryHint?: Record<string, unknown>;
}): Promise<AgentMateParams | null> {
  // Fast-path: skip LLM entirely → geometry inference takes over
  if (DEMO_FAST_PATH) return null;

  // Cache check: if we've already inferred for this part pair, reuse
  const cacheKey = _mateParamsCacheKey(params.sourcePart.name, params.targetPart.name);
  const cached = _mateParamsCache.get(cacheKey);
  if (cached) return cached;

  try {
    const raw: any = await v2Client.request('agent.infer_mate_params', {
      userText: params.userText,
      sourcePart: params.sourcePart,
      targetPart: params.targetPart,
      geometryHint: params.geometryHint,
    });
    const inference = raw?.inference;
    if (!inference || typeof inference !== 'object') return null;

    const VALID_FACES: StoreFaceId[] = ['top', 'bottom', 'left', 'right', 'front', 'back'];
    const VALID_MODES: MateExecMode[] = ['translate', 'twist', 'both'];
    const VALID_METHODS: AnchorMethodId[] = [
      'auto', 'planar_cluster', 'geometry_aabb', 'object_aabb',
      'extreme_vertices', 'obb_pca', 'picked',
    ];
    const VALID_INTENTS: MateIntentKind[] = ['default', 'cover', 'insert', 'twist_insert', 'arc_cover'];

    const result: AgentMateParams = {
      intent: VALID_INTENTS.includes(inference.intent) ? inference.intent : 'default',
      mode: VALID_MODES.includes(inference.mode) ? inference.mode : 'translate',
      sourceFace: VALID_FACES.includes(inference.sourceFace) ? inference.sourceFace : 'bottom',
      targetFace: VALID_FACES.includes(inference.targetFace) ? inference.targetFace : 'top',
      sourceMethod: VALID_METHODS.includes(inference.sourceMethod) ? inference.sourceMethod : 'auto',
      targetMethod: VALID_METHODS.includes(inference.targetMethod) ? inference.targetMethod : 'auto',
      confidence: typeof inference.confidence === 'number'
        ? Math.min(1, Math.max(0, inference.confidence)) : 0.5,
      ...(typeof inference.reasoning === 'string' ? { reasoning: inference.reasoning } : {}),
    };
    // Cache successful result for repeated calls with the same part pair
    _mateParamsCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Save a mate recipe to the server so future mate calls for this part pair
 * bypass LLM and use the saved faces/methods directly.
 */
async function saveMateRecipe(params: {
  sourceName: string;
  targetName: string;
  sourceFace: string;
  targetFace: string;
  sourceMethod?: string;
  targetMethod?: string;
  note?: string;
  whyDescription?: string;
  pattern?: string;
  antiPattern?: string;
  geometrySignal?: string;
}): Promise<boolean> {
  try {
    await v2Client.request('agent.save_mate_recipe', params);
    return true;
  } catch {
    return false;
  }
}

function defaultModeForIntent(intent: MateIntentKind): MateExecMode {
  // insert typically needs rotation correction too (part may be rotated before insertion)
  if (intent === 'insert') return 'both';
  return 'translate';
}

/**
 * Geometry-based intent inference — used as a fallback when LLM inference is unavailable.
 * LLM is the primary decision-maker; this only runs when callAgentForMateParams() returns null.
 */
function inferIntentFromGeometryFallback(
  sourceObject: THREE.Object3D,
  targetObject: THREE.Object3D
): MateIntentKind | null {
  const sourceBox = new THREE.Box3().setFromObject(sourceObject);
  const targetBox = new THREE.Box3().setFromObject(targetObject);
  if (sourceBox.isEmpty() || targetBox.isEmpty()) return null;

  const sourceSize = sourceBox.getSize(new THREE.Vector3());
  const targetSize = targetBox.getSize(new THREE.Vector3());
  const delta = targetBox.getCenter(new THREE.Vector3()).sub(sourceBox.getCenter(new THREE.Vector3()));

  const overlapRatio = (aMin: number, aMax: number, bMin: number, bMax: number) => {
    const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
    return overlap / Math.max(1e-6, Math.min(aMax - aMin, bMax - bMin));
  };
  const overlapX = overlapRatio(sourceBox.min.x, sourceBox.max.x, targetBox.min.x, targetBox.max.x);
  const overlapY = overlapRatio(sourceBox.min.y, sourceBox.max.y, targetBox.min.y, targetBox.max.y);
  const overlapZ = overlapRatio(sourceBox.min.z, sourceBox.max.z, targetBox.min.z, targetBox.max.z);

  const fitsXZ = sourceSize.x <= targetSize.x * 0.94 && sourceSize.z <= targetSize.z * 0.94;
  const fitsXY = sourceSize.x <= targetSize.x * 0.94 && sourceSize.y <= targetSize.y * 0.94;
  const fitsYZ = sourceSize.y <= targetSize.y * 0.94 && sourceSize.z <= targetSize.z * 0.94;
  if ((fitsXZ && overlapX > 0.45 && overlapZ > 0.45) ||
      (fitsXY && overlapX > 0.45 && overlapY > 0.45) ||
      (fitsYZ && overlapY > 0.45 && overlapZ > 0.45)) return 'insert';

  const stackedY = Math.abs(delta.y) > (sourceSize.y + targetSize.y) * 0.22 && overlapX > 0.5 && overlapZ > 0.5;
  if (stackedY) return 'cover';

  return null;
}

function getExpectedFacePairFromCenters(sourceCenter: THREE.Vector3, targetCenter: THREE.Vector3) {
  const delta = targetCenter.clone().sub(sourceCenter);
  const absDelta = new THREE.Vector3(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
  if (absDelta.x >= absDelta.y && absDelta.x >= absDelta.z) {
    return delta.x >= 0
      ? { sourceFace: 'right' as StoreFaceId, targetFace: 'left' as StoreFaceId }
      : { sourceFace: 'left' as StoreFaceId, targetFace: 'right' as StoreFaceId };
  }
  if (absDelta.y >= absDelta.x && absDelta.y >= absDelta.z) {
    return delta.y >= 0
      ? { sourceFace: 'top' as StoreFaceId, targetFace: 'bottom' as StoreFaceId }
      : { sourceFace: 'bottom' as StoreFaceId, targetFace: 'top' as StoreFaceId };
  }
  return delta.z >= 0
    ? { sourceFace: 'front' as StoreFaceId, targetFace: 'back' as StoreFaceId }
    : { sourceFace: 'back' as StoreFaceId, targetFace: 'front' as StoreFaceId };
}

/**
 * Build anchor method priority list based on intent and explicit override.
 * Intent-based defaults are now driven by LLM inference (see callAgentForMateParams),
 * but this remains as a fallback when LLM is unavailable.
 */
function buildMethodPriority(params: {
  explicit?: AnchorMethodId | null;
  instructionMethod?: AnchorMethodId | null;
  intent: MateIntentKind;
  role: 'source' | 'target';
}): AnchorMethodId[] {
  const { explicit, instructionMethod, intent } = params;
  if (explicit) return [normalizeAnchorMethod(explicit)];
  if (instructionMethod) {
    const preferred = normalizeAnchorMethod(instructionMethod);
    return [preferred, 'planar_cluster', 'geometry_aabb', 'object_aabb', 'obb_pca'].filter(
      (value, index, array) => array.indexOf(value) === index
    ) as AnchorMethodId[];
  }
  if (intent === 'insert') {
    return ['planar_cluster', 'geometry_aabb', 'obb_pca', 'object_aabb'];
  }

  if (intent === 'cover') {
    return ['planar_cluster', 'geometry_aabb', 'object_aabb', 'obb_pca'];
  }

  return ['planar_cluster', 'geometry_aabb', 'object_aabb', 'obb_pca'];
}

function resolveFaceCandidate(
  object: THREE.Object3D,
  face: StoreFaceId,
  methods: AnchorMethodId[]
): FaceAnchorCandidate | null {
  object.updateWorldMatrix(true, false);
  for (const method of methods) {
    const anchor = resolveAnchor({ object, faceId: face, method });
    if (!anchor) continue;
    const centerWorld = anchor.centerLocal.clone().applyMatrix4(object.matrixWorld);
    const normalWorld = normalize(anchor.normalLocal.clone().transformDirection(object.matrixWorld), new THREE.Vector3(0, 1, 0));
    return {
      face,
      method,
      centerWorld,
      normalWorld,
      areaHint: Number(anchor.debug?.area || 0),
    };
  }
  return null;
}

function inferBestFacePair(params: {
  sourceObject: THREE.Object3D;
  targetObject: THREE.Object3D;
  sourceMethods: AnchorMethodId[];
  targetMethods: AnchorMethodId[];
  preferredSourceFace?: StoreFaceId | null;
  preferredTargetFace?: StoreFaceId | null;
  limit?: number;
  intent?: MateIntentKind;
}): FacePairSuggestion | null {
  const {
    sourceObject,
    targetObject,
    sourceMethods,
    targetMethods,
    preferredSourceFace,
    preferredTargetFace,
    limit,
    intent,
  } = params;

  const sourceCenter = new THREE.Box3().setFromObject(sourceObject).getCenter(new THREE.Vector3());
  const targetCenter = new THREE.Box3().setFromObject(targetObject).getCenter(new THREE.Vector3());
  const sourceToTarget = targetCenter.clone().sub(sourceCenter);
  const sourceToTargetDir = normalize(sourceToTarget, new THREE.Vector3(0, 1, 0));
  const centerExpectedFaces = getExpectedFacePairFromCenters(sourceCenter, targetCenter);

  // For insert intent the source part is not yet positioned near the target cavity — the
  // center-to-center direction is misleading.  Use a canonical insert pair (source bottom →
  // target top) as the geometry expectation instead.  This correctly identifies the cavity
  // opening (target local +Y) and the mating face of the part being inserted.
  const expectedFaces: { sourceFace: StoreFaceId; targetFace: StoreFaceId } =
    intent === 'insert'
      ? { sourceFace: 'bottom', targetFace: 'top' }
      : centerExpectedFaces;

  const sourceFaces = preferredSourceFace ? [preferredSourceFace] : STORE_FACES;
  const targetFaces = preferredTargetFace ? [preferredTargetFace] : STORE_FACES;

  const sourceCandidates = sourceFaces
    .map((face) => resolveFaceCandidate(sourceObject, face, sourceMethods))
    .filter(Boolean) as FaceAnchorCandidate[];
  const targetCandidates = targetFaces
    .map((face) => resolveFaceCandidate(targetObject, face, targetMethods))
    .filter(Boolean) as FaceAnchorCandidate[];

  if (!sourceCandidates.length || !targetCandidates.length) return null;

  const ranking: FacePairSuggestion['ranking'] = [];
  for (const sourceCandidate of sourceCandidates) {
    for (const targetCandidate of targetCandidates) {
      const facingScore = (sourceCandidate.normalWorld.dot(targetCandidate.normalWorld.clone().negate()) + 1) * 0.5;
      const sourceApproach = (sourceCandidate.normalWorld.dot(sourceToTargetDir) + 1) * 0.5;
      const targetApproach = (targetCandidate.normalWorld.clone().negate().dot(sourceToTargetDir) + 1) * 0.5;
      const approachScore = (sourceApproach + targetApproach) * 0.5;
      const centerDistance = sourceCandidate.centerWorld.distanceTo(targetCandidate.centerWorld);
      const distanceScore = 1 / (1 + centerDistance);
      // Positional expectedFaceScore is intentionally tiny (0.02) so that geometry-based
      // normal/approach scores dominate.  Moving a part laterally should not flip which
      // faces are selected — geometry normals decide that, not relative position.
      const expectedFaceScore =
        (sourceCandidate.face === expectedFaces.sourceFace ? 0.5 : 0) +
        (targetCandidate.face === expectedFaces.targetFace ? 0.5 : 0);

      // For insert: the source is not yet near its final position, so approach/distance scores
      // based on current positions are misleading.  Use only facingScore + expectedFaceScore.
      const score =
        intent === 'insert'
          ? facingScore * 0.55 + expectedFaceScore * 0.45
          : facingScore * 0.42 +
            approachScore * 0.24 +
            distanceScore * 0.20 +
            expectedFaceScore * 0.10 +
            Math.min((sourceCandidate.areaHint + targetCandidate.areaHint) / 200, 0.04);

      ranking.push({
        sourceFace: sourceCandidate.face,
        targetFace: targetCandidate.face,
        sourceMethod: sourceCandidate.method,
        targetMethod: targetCandidate.method,
        score,
        facingScore,
        approachScore,
        distanceScore,
        expectedFaceScore,
      });
    }
  }

  ranking.sort((left, right) => right.score - left.score);
  if (!ranking.length) return null;
  const best = ranking[0];
  return {
    sourceFace: best.sourceFace,
    targetFace: best.targetFace,
    sourceMethod: best.sourceMethod,
    targetMethod: best.targetMethod,
    score: best.score,
    ranking: ranking.slice(0, Math.max(1, limit ?? 8)),
  };
}

function vec3(v: [number, number, number]) {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

function tuple3(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

function quat4(v: [number, number, number, number]) {
  return new THREE.Quaternion(v[0], v[1], v[2], v[3]);
}

function tuple4(q: THREE.Quaternion): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

function currentStore() {
  return useV2Store.getState();
}

function viewSnapshot() {
  const view = currentStore().view;
  return {
    environment: view.environment,
    showGrid: view.showGrid,
    showAnchors: view.showAnchors,
  };
}

function resetRuntimeForNewScene() {
  runtimeState.selection = { active: null, stack: [] };
  runtimeState.plans.clear();
  runtimeState.preview = null;
  runtimeState.previewBeforeTransformByPartId.clear();
  runtimeState.rotateSessions.clear();
  runtimeState.interactionMode = 'move';
  candidateRegistry.clear();
  clearRegistry();
}

/**
 * Lazily populate the semantic registry from the store if it's empty.
 * Call before any grounding operation to ensure basic cards exist.
 */
function syncRegistryIfEmpty(): void {
  if (getAllCards().length > 0) return;
  const store = currentStore();
  const parts = store.parts.order.map((id) => ({
    partId: id,
    name: store.parts.byId[id]?.name ?? id,
  }));
  syncRegistryFromStore(parts);
}

/**
 * LLM fallback for grounding: if heuristic failed to find candidates,
 * ask the server to parse concepts from the utterance.
 * Returns the enriched result, or the original heuristic result on failure.
 */
async function enrichGroundingWithLlm(
  utterance: string,
  heuristicResult: GroundingResult,
  selectedPartIds?: string[],
): Promise<GroundingResult> {
  const needsLlmFallback =
    heuristicResult.needsClarification &&
    !heuristicResult.usedSelectionFallback &&
    heuristicResult.sourceCandidates.length === 0 &&
    heuristicResult.targetCandidates.length === 0;

  if (!needsLlmFallback) return heuristicResult;

  try {
    const allPartNames = getAllCards().map(c => c.partName).slice(0, 30);
    const conceptResp = await v2Client.request('agent.parse_grounding_concepts', {
      utterance,
      scenePartNames: allPartNames,
    }) as { concepts?: { sourceConcept?: string; targetConcept?: string; assemblyIntent?: string; utteranceType?: string; usesDeictic?: boolean } };

    const concepts = conceptResp?.concepts;
    if (concepts?.sourceConcept || concepts?.targetConcept) {
      const enriched = groundObjects(utterance, {
        selectedPartIds,
        parsedConcepts: {
          sourceConcept: concepts.sourceConcept,
          targetConcept: concepts.targetConcept,
          assemblyIntent: concepts.assemblyIntent,
          utteranceType: (concepts.utteranceType as any) ?? 'conceptual',
          usesDeictic: concepts.usesDeictic ?? false,
        },
      });
      enriched.diagnostics.push('used LLM concept parsing fallback');
      return enriched;
    }
  } catch {
    heuristicResult.diagnostics.push('LLM concept parsing fallback failed (using heuristic result)');
  }
  return heuristicResult;
}

function commitRevision(mutating: boolean) {
  if (mutating) runtimeState.sceneRevision += 1;
  return runtimeState.sceneRevision;
}

function ok<T>(data: T, options?: { mutating?: boolean; warnings?: ToolWarning[]; debug?: unknown }): ToolSuccess<T> {
  return {
    ok: true,
    sceneRevision: commitRevision(Boolean(options?.mutating)),
    data,
    warnings: options?.warnings ?? [],
    ...(options?.debug === undefined ? {} : { debug: options.debug }),
  };
}

function fail(error: ToolExecutionError): ToolFailure {
  return {
    ok: false,
    sceneRevision: runtimeState.sceneRevision,
    error: {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      detail: error.detail,
      suggestedToolCalls: error.suggestedToolCalls,
    },
    warnings: [],
  };
}

function unwrapToolData(result: ToolEnvelope, defaultCode: ToolErrorCode = 'INTERNAL_ERROR') {
  if (result.ok) return result.data as any;
  throw new ToolExecutionError({
    code: (result.error?.code as ToolErrorCode | undefined) ?? defaultCode,
    message: result.error?.message ?? 'Nested tool execution failed',
    recoverable: result.error?.recoverable ?? true,
    detail: result.error?.detail,
    suggestedToolCalls: result.error?.suggestedToolCalls ?? [],
  });
}

function getObjectByPartIdOrThrow(partId: string) {
  const object = getV2ObjectByPartId(partId);
  if (!object) {
    throw new ToolExecutionError({
      code: 'SCENE_OUT_OF_SYNC',
      message: `Part object not found in active scene: ${partId}`,
      recoverable: true,
      suggestedToolCalls: [
        { tool: 'query.scene_state', args: {}, reason: 'Confirm scene parts' },
      ],
    });
  }
  object.updateWorldMatrix(true, false);
  return object;
}

function getRendererOrThrow() {
  const renderer = getV2Renderer();
  const scene = getV2Scene();
  const camera = getV2Camera();
  const viewportPx = getV2ViewportPx();
  if (!renderer || !scene || !camera || !viewportPx) {
    throw new ToolExecutionError({
      code: 'SCENE_OUT_OF_SYNC',
      message: 'Three.js context not ready for view capture',
      recoverable: true,
      detail: { renderer: Boolean(renderer), scene: Boolean(scene), camera: Boolean(camera), viewportPx: Boolean(viewportPx) },
      suggestedToolCalls: [
        { tool: 'query.scene_state', args: {}, reason: 'Confirm scene + retry after render' },
      ],
    });
  }
  return { renderer, scene, camera, viewportPx };
}

function worldBoundingBoxFromObject(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    const zero = new THREE.Vector3();
    return {
      min: tuple3(zero),
      max: tuple3(zero),
      size: tuple3(zero),
      center: tuple3(zero),
      space: 'world' as const,
    };
  }
  const min = box.min.clone();
  const max = box.max.clone();
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    min: tuple3(min),
    max: tuple3(max),
    size: tuple3(size),
    center: tuple3(center),
    space: 'world' as const,
  };
}

function frameWorldFromAnchor(object: THREE.Object3D, anchor: { centerLocal: THREE.Vector3; normalLocal: THREE.Vector3; tangentLocal?: THREE.Vector3 }) {
  const centerWorld = anchor.centerLocal.clone().applyMatrix4(object.matrixWorld);
  const normalWorld = normalize(anchor.normalLocal.clone().transformDirection(object.matrixWorld), new THREE.Vector3(0, 1, 0));
  const tangentLocal =
    anchor.tangentLocal && anchor.tangentLocal.lengthSq() > 1e-10
      ? anchor.tangentLocal.clone().normalize()
      : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), anchor.normalLocal).lengthSq() > 1e-10
      ? new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), anchor.normalLocal).normalize()
      : new THREE.Vector3(1, 0, 0);
  const tangentWorld = normalize(tangentLocal.clone().transformDirection(object.matrixWorld), new THREE.Vector3(1, 0, 0));
  const bitangentWorld = normalize(new THREE.Vector3().crossVectors(normalWorld, tangentWorld), new THREE.Vector3(0, 0, 1));
  const fixedTangentWorld = normalize(new THREE.Vector3().crossVectors(bitangentWorld, normalWorld), tangentWorld);
  return {
    origin: tuple3(centerWorld),
    normal: tuple3(normalWorld),
    tangent: tuple3(fixedTangentWorld),
    bitangent: tuple3(bitangentWorld),
  };
}

function clampInt(value: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}


type CaptureImagePayload = {
  name: string;
  label: string;
  mime: string;
  widthPx: number;
  heightPx: number;
  dataBase64: string;
  cameraPose?: [number, number, number, number, number, number, number, number, number];
};

function dataUrlToBase64(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl;
  return dataUrl.slice(comma + 1);
}

function renderCaptureWithCamera(params: {
  camera: THREE.Camera;
  maxWidthPx: number;
  maxHeightPx: number;
  format: 'png' | 'jpeg';
  jpegQuality?: number;
}) {
  const { renderer, scene, viewportPx } = getRendererOrThrow();
  const mimeType = params.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const size = computeCaptureSize({
    viewportWidth: viewportPx.width,
    viewportHeight: viewportPx.height,
    maxWidthPx: params.maxWidthPx,
    maxHeightPx: params.maxHeightPx,
  });

  const prevTarget = renderer.getRenderTarget();
  const renderTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const pixels = new Uint8Array(size.width * size.height * 4);

  try {
    const captureCamera = params.camera;
    if ((captureCamera as any).isPerspectiveCamera) {
      const pcam = captureCamera as THREE.PerspectiveCamera;
      pcam.aspect = size.width / Math.max(1, size.height);
      pcam.updateProjectionMatrix();
    } else if ((captureCamera as any).isOrthographicCamera) {
      (captureCamera as THREE.OrthographicCamera).updateProjectionMatrix();
    }

    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, captureCamera);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, size.width, size.height, pixels);
  } catch (error: any) {
    throw new ToolExecutionError({
      code: 'UNSUPPORTED_OPERATION',
      message: `View capture failed: ${error?.message || 'unknown'}`,
      recoverable: true,
    });
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderTarget.dispose();
  }

  try {
    const dataUrl = dataUrlFromPixels({
      pixels,
      width: size.width,
      height: size.height,
      mimeType,
      jpegQuality: params.jpegQuality,
    });
    return {
      dataUrl,
      mimeType,
      widthPx: size.width,
      heightPx: size.height,
    };
  } catch (error: any) {
    throw new ToolExecutionError({
      code: 'UNSUPPORTED_OPERATION',
      message: `View capture encode failed: ${error?.message || 'unknown'}`,
      recoverable: true,
    });
  }
}

function cloneCameraForView(baseCamera: THREE.Camera) {
  const clone = baseCamera.clone() as THREE.Camera;
  clone.updateMatrixWorld(true);
  return clone;
}

function configureCaptureCameraPose(params: {
  camera: THREE.Camera;
  eye: THREE.Vector3;
  target: THREE.Vector3;
  up?: THREE.Vector3;
}) {
  const { camera, eye, target, up } = params;
  camera.position.copy(eye);
  if (up && (camera as any).up) (camera as any).up.copy(up);
  (camera as any).lookAt?.(target);
  camera.updateMatrixWorld(true);
}

function buildMateCaptureImages(params: {
  sourceObject: THREE.Object3D;
  targetObject: THREE.Object3D;
  sourceLabel: string;
  targetLabel: string;
  maxViews: number;
  maxWidthPx: number;
  maxHeightPx: number;
  format: 'png' | 'jpeg';
  jpegQuality?: number;
  /** Override the source BBox used for camera framing (e.g. combined group box). */
  sourceBoxOverride?: THREE.Box3;
  /** Override the target BBox used for camera framing (e.g. combined group box). */
  targetBoxOverride?: THREE.Box3;
}) {
  const { camera: baseCamera } = getRendererOrThrow();
  const sourceBox = params.sourceBoxOverride ?? new THREE.Box3().setFromObject(params.sourceObject);
  const targetBox = params.targetBoxOverride ?? new THREE.Box3().setFromObject(params.targetObject);
  const pairBox = sourceBox.clone().union(targetBox);

  const sourceCenter = sourceBox.isEmpty() ? getWorldCenterFromObject(params.sourceObject) : sourceBox.getCenter(new THREE.Vector3());
  const targetCenter = targetBox.isEmpty() ? getWorldCenterFromObject(params.targetObject) : targetBox.getCenter(new THREE.Vector3());
  const pairCenter = sourceCenter.clone().add(targetCenter).multiplyScalar(0.5);
  const sourceIntrinsicSize = sourceBox.isEmpty() ? getIntrinsicSizeFromObject(params.sourceObject) : sourceBox.getSize(new THREE.Vector3());
  const targetIntrinsicSize = targetBox.isEmpty() ? getIntrinsicSizeFromObject(params.targetObject) : targetBox.getSize(new THREE.Vector3());
  const pairIntrinsicSize = sourceIntrinsicSize.clone().max(targetIntrinsicSize);
  // Use world-space bounding box size for camera distance (pairBox is already in world space).
  // Using root-local intrinsicSize caused wrong distances when objects had non-unit scale.
  const pairDiag = Math.max(1e-3, pairBox.getSize(new THREE.Vector3()).length());
  const pairDelta = targetCenter.clone().sub(sourceCenter);
  const absPairDelta = new THREE.Vector3(Math.abs(pairDelta.x), Math.abs(pairDelta.y), Math.abs(pairDelta.z));
  const pairDist = Math.max(1e-3, pairDelta.length());
  const dirST = pairDelta.lengthSq() > 1e-8 ? pairDelta.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const targetQuaternion = params.targetObject.getWorldQuaternion(new THREE.Quaternion());
  const frameRight = new THREE.Vector3(1, 0, 0).applyQuaternion(targetQuaternion).normalize();
  const frameUp = new THREE.Vector3(0, 1, 0).applyQuaternion(targetQuaternion).normalize();
  const frameFront = new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuaternion).normalize();

  const defaultDistance = Math.max(pairDiag * 1.4, pairDist * 1.35, 0.5);
  const closeDistance = Math.max(pairDiag * 0.9, pairDist * 1.0, 0.35);

  const viewSpecs: Array<{
    name: string;
    label: string;
    eye: THREE.Vector3;
    target: THREE.Vector3;
    up?: THREE.Vector3;
  }> = [
    {
      name: 'overview_iso_a',
      label: 'Overview ISO A',
      eye: pairCenter
        .clone()
        .add(frameRight.clone().add(frameUp.clone().multiplyScalar(0.75)).add(frameFront).normalize().multiplyScalar(defaultDistance)),
      target: pairCenter.clone(),
    },
    {
      name: 'overview_iso_b',
      label: 'Overview ISO B',
      eye: pairCenter
        .clone()
        .add(
          frameRight
            .clone()
            .multiplyScalar(-1)
            .add(frameUp.clone().multiplyScalar(0.7))
            .add(frameFront.clone().multiplyScalar(-0.85))
            .normalize()
            .multiplyScalar(defaultDistance)
        ),
      target: pairCenter.clone(),
    },
    {
      name: 'top',
      label: 'Top',
      eye: pairCenter.clone().add(frameUp.clone().multiplyScalar(defaultDistance)),
      target: pairCenter.clone(),
      up: frameFront.clone().multiplyScalar(-1),
    },
    {
      name: 'front',
      label: 'Front',
      eye: pairCenter
        .clone()
        .add(frameFront.clone().add(frameUp.clone().multiplyScalar(0.15)).normalize().multiplyScalar(defaultDistance)),
      target: pairCenter.clone(),
    },
    {
      name: 'right',
      label: 'Right',
      eye: pairCenter
        .clone()
        .add(frameRight.clone().add(frameUp.clone().multiplyScalar(0.12)).normalize().multiplyScalar(defaultDistance)),
      target: pairCenter.clone(),
    },
    {
      name: 'source_to_target',
      label: `${params.sourceLabel} -> ${params.targetLabel}`,
      eye: sourceCenter.clone().sub(dirST.clone().multiplyScalar(closeDistance)).add(frameUp.clone().multiplyScalar(pairDiag * 0.18)),
      target: pairCenter.clone(),
    },
    {
      name: 'target_to_source',
      label: `${params.targetLabel} -> ${params.sourceLabel}`,
      eye: targetCenter.clone().add(dirST.clone().multiplyScalar(closeDistance)).add(frameUp.clone().multiplyScalar(pairDiag * 0.18)),
      target: pairCenter.clone(),
    },
  ];

  const viewByName = new Map(viewSpecs.map((spec) => [spec.name, spec]));
  const sideViewName = absPairDelta.x >= absPairDelta.z ? 'right' : 'front';
  const preferredOrder: string[] = [
    'overview_iso_a',
    'top',
    'source_to_target',
    'target_to_source',
    sideViewName,
    'overview_iso_b',
    'front',
    'right',
  ];
  const selectedNames: string[] = [];
  for (const name of preferredOrder) {
    if (!viewByName.has(name)) continue;
    if (selectedNames.includes(name)) continue;
    selectedNames.push(name);
    if (selectedNames.length >= params.maxViews) break;
  }
  if (selectedNames.length < Math.max(2, params.maxViews)) {
    for (const spec of viewSpecs) {
      if (selectedNames.includes(spec.name)) continue;
      selectedNames.push(spec.name);
      if (selectedNames.length >= params.maxViews) break;
    }
  }
  const selected = selectedNames
    .map((name) => viewByName.get(name))
    .filter(Boolean)
    .slice(0, Math.max(2, Math.min(params.maxViews, viewSpecs.length))) as typeof viewSpecs;
  const images: CaptureImagePayload[] = [];
  for (const spec of selected) {
    const captureCamera = cloneCameraForView(baseCamera);
    configureCaptureCameraPose({
      camera: captureCamera,
      eye: spec.eye,
      target: spec.target,
      up: spec.up,
    });
    const image = renderCaptureWithCamera({
      camera: captureCamera,
      maxWidthPx: params.maxWidthPx,
      maxHeightPx: params.maxHeightPx,
      format: params.format,
      jpegQuality: params.jpegQuality,
    });
    images.push({
      name: `${spec.name}.${params.format === 'jpeg' ? 'jpg' : 'png'}`,
      label: spec.label,
      mime: image.mimeType,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      dataBase64: dataUrlToBase64(image.dataUrl),
      cameraPose: [...tuple3(spec.eye), ...tuple3(spec.target), ...tuple3(spec.up || frameUp)] as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ],
    });
  }
  return {
    images,
    sourceCenter: tuple3(sourceCenter),
    targetCenter: tuple3(targetCenter),
    pairCenter: tuple3(pairCenter),
    pairSize: tuple3(pairBox.getSize(new THREE.Vector3())),
    pairIntrinsicSize: tuple3(pairIntrinsicSize),
    pairDistance: pairDist,
    captureFrame: {
      referencePart: params.targetLabel,
      rightWorld: tuple3(frameRight),
      upWorld: tuple3(frameUp),
      frontWorld: tuple3(frameFront),
      note: 'face directions are interpreted in target-object frame',
    },
  };
}

function resolvePart(part: PartRef): ResolvedPart {
  const store = currentStore();
  const byId = store.parts.byId;
  const order = store.parts.order;

  if (part.partId && byId[part.partId]) {
    const found = byId[part.partId];
    return {
      partId: found.id,
      partName: found.name,
      confidence: 1,
      autoCorrected: false,
    };
  }

  if (!part.partName) {
    throw new ToolExecutionError({ code: 'NOT_FOUND', message: 'partName is required when partId is missing' });
  }

  // Support "group_name/part_name" path notation
  if (part.partName.includes('/')) {
    const slashIdx = part.partName.indexOf('/');
    const groupSegment = part.partName.slice(0, slashIdx).trim().toLowerCase();
    const partSegment = part.partName.slice(slashIdx + 1).trim().toLowerCase();
    const matchedGroup = Object.values(store.assemblyGroups.byId).find(
      (g) => g.name.trim().toLowerCase() === groupSegment
    );
    if (matchedGroup) {
      const matchedPartId = matchedGroup.partIds.find(
        (id) => (byId[id]?.name ?? '').trim().toLowerCase() === partSegment
      );
      if (matchedPartId) {
        const found = byId[matchedPartId];
        return { partId: found.id, partName: found.name, confidence: 1, autoCorrected: false };
      }
    }
    // Fall through to normal resolution using just the part segment if group not found
  }

  const query = part.partName.includes('/')
    ? part.partName.slice(part.partName.indexOf('/') + 1).trim().toLowerCase()
    : part.partName.trim().toLowerCase();
  const exact = order.filter((id) => byId[id]?.name.toLowerCase() === query);
  if (exact.length === 1) {
    const found = byId[exact[0]];
    return {
      partId: found.id,
      partName: found.name,
      confidence: 1,
      autoCorrected: found.name.toLowerCase() !== query,
      reason: found.name.toLowerCase() !== query ? 'case-normalized match' : undefined,
    };
  }

  const fuzzy = order.filter((id) => byId[id]?.name.toLowerCase().includes(query));
  if (fuzzy.length === 1) {
    const found = byId[fuzzy[0]];
    return {
      partId: found.id,
      partName: found.name,
      confidence: 0.85,
      autoCorrected: true,
      reason: 'fuzzy name match',
    };
  }

  if (exact.length > 1 || fuzzy.length > 1) {
    const candidates = (exact.length > 1 ? exact : fuzzy).map((id) => byId[id]?.name || id);
    throw new ToolExecutionError({
      code: 'AMBIGUOUS_SELECTION',
      message: `partName '${part.partName}' matches multiple parts`,
      detail: { candidates },
      suggestedToolCalls: [
        {
          tool: 'query.scene_state',
          args: { verbosity: 'summary' },
          reason: 'List available parts for clarification',
        },
      ],
    });
  }

  throw new ToolExecutionError({
    code: 'NOT_FOUND',
    message: `Part '${part.partName}' not found`,
    suggestedToolCalls: [{ tool: 'query.scene_state', args: { verbosity: 'summary' } }],
  });
}

function getPartTransformOrThrow(partId: string): PartTransform {
  const transform = currentStore().getPartTransform(partId);
  if (!transform) {
    throw new ToolExecutionError({ code: 'NOT_FOUND', message: `Transform for part '${partId}' not found` });
  }
  return transform;
}

function normalize(v: THREE.Vector3, fallback: THREE.Vector3) {
  if (v.lengthSq() < 1e-8) return fallback.clone();
  return v.normalize();
}

function computeFaceFrame(transform: PartTransform, face: string): Frame {
  const faceId = String(face) as StoreFaceId | 'center' | 'picked';
  const position = vec3(transform.position);
  const scale = new THREE.Vector3(Math.abs(transform.scale[0]), Math.abs(transform.scale[1]), Math.abs(transform.scale[2]));
  const half = scale.clone().multiplyScalar(0.5);
  const q = quat4(transform.quaternion).normalize();

  let localNormal = new THREE.Vector3(0, 1, 0);
  let localTangent = new THREE.Vector3(1, 0, 0);
  let localOffset = new THREE.Vector3(0, half.y, 0);

  switch (faceId) {
    case 'top':
      localNormal = new THREE.Vector3(0, 1, 0);
      localTangent = new THREE.Vector3(1, 0, 0);
      localOffset = new THREE.Vector3(0, half.y, 0);
      break;
    case 'bottom':
      localNormal = new THREE.Vector3(0, -1, 0);
      localTangent = new THREE.Vector3(1, 0, 0);
      localOffset = new THREE.Vector3(0, -half.y, 0);
      break;
    case 'left':
      localNormal = new THREE.Vector3(-1, 0, 0);
      localTangent = new THREE.Vector3(0, 0, 1);
      localOffset = new THREE.Vector3(-half.x, 0, 0);
      break;
    case 'right':
      localNormal = new THREE.Vector3(1, 0, 0);
      localTangent = new THREE.Vector3(0, 0, 1);
      localOffset = new THREE.Vector3(half.x, 0, 0);
      break;
    case 'front':
      localNormal = new THREE.Vector3(0, 0, 1);
      localTangent = new THREE.Vector3(1, 0, 0);
      localOffset = new THREE.Vector3(0, 0, half.z);
      break;
    case 'back':
      localNormal = new THREE.Vector3(0, 0, -1);
      localTangent = new THREE.Vector3(1, 0, 0);
      localOffset = new THREE.Vector3(0, 0, -half.z);
      break;
    case 'center':
    case 'picked':
      localNormal = new THREE.Vector3(0, 1, 0);
      localTangent = new THREE.Vector3(1, 0, 0);
      localOffset = new THREE.Vector3(0, 0, 0);
      break;
    default:
      break;
  }

  const normalWorld = normalize(localNormal.applyQuaternion(q), new THREE.Vector3(0, 1, 0));
  const tangentWorldRaw = localTangent.applyQuaternion(q);
  const tangentWorld = normalize(
    tangentWorldRaw.clone().sub(normalWorld.clone().multiplyScalar(tangentWorldRaw.dot(normalWorld))),
    new THREE.Vector3(1, 0, 0)
  );
  const bitangentWorld = normalize(normalWorld.clone().cross(tangentWorld), new THREE.Vector3(0, 0, 1));
  const origin = position.clone().add(localOffset.applyQuaternion(q));

  return {
    origin: tuple3(origin),
    normal: tuple3(normalWorld),
    tangent: tuple3(tangentWorld),
    bitangent: tuple3(bitangentWorld),
  };
}

function quaternionFromFrame(frame: Frame) {
  const normal = normalize(vec3(frame.normal), new THREE.Vector3(0, 1, 0));
  const tangent = normalize(
    vec3(frame.tangent)
      .clone()
      .sub(normal.clone().multiplyScalar(vec3(frame.tangent).dot(normal))),
    Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  );
  const bitangent = normalize(normal.clone().cross(tangent), new THREE.Vector3(0, 0, 1));
  const matrix = new THREE.Matrix4().makeBasis(tangent, bitangent, normal);
  return new THREE.Quaternion().setFromRotationMatrix(matrix).normalize();
}

function resolveFeature(feature: FeatureRef): ResolvedFeature {
  if (feature.kind === 'part') {
    const part = resolvePart(feature.part);
    return { kind: 'part', part };
  }

  if (feature.kind === 'face') {
    const part = resolvePart(feature.part);
    const methodRequested = normalizeAnchorMethod(feature.method, 'planar_cluster');
    const methodUsed = methodRequested;
    return {
      kind: 'face',
      part,
      face: feature.face,
      methodRequested,
      methodUsed,
      fallbackUsed: false,
    };
  }

  if (feature.kind === 'edge') {
    return {
      kind: 'edge',
      part: resolvePart(feature.part),
      edgeId: feature.edgeId,
    };
  }

  if (feature.kind === 'axis') {
    return {
      kind: 'axis',
      part: resolvePart(feature.part),
      axisId: feature.axisId,
      axisVector: feature.axisVector ?? [0, 1, 0],
    };
  }

  return {
    kind: 'point',
    part: resolvePart(feature.part),
    pointId: feature.pointId,
    point: feature.point ?? [0, 0, 0],
  };
}

function featureFrame(feature: ResolvedFeature): Frame {
  if (feature.kind === 'face') {
    const face = feature.face;
    if (face === 'picked' || face === 'center') {
      const transform = getPartTransformOrThrow(feature.part.partId);
      return {
        origin: transform.position,
        normal: [0, 1, 0],
        tangent: [1, 0, 0],
        bitangent: [0, 0, 1],
      };
    }

    const obj = getV2ObjectByPartId(feature.part.partId);
    if (obj) {
      const anchor = resolveAnchor({
        object: obj,
        faceId: face,
        method: feature.methodUsed as any,
      });
      if (anchor) {
        const originWorld = anchor.centerLocal.clone().applyMatrix4(obj.matrixWorld);
        const normalWorld = normalize(anchor.normalLocal.clone().transformDirection(obj.matrixWorld), new THREE.Vector3(0, 1, 0));
        const tangentWorldRaw = anchor.tangentLocal.clone().transformDirection(obj.matrixWorld);
        const tangentWorld = normalize(
          tangentWorldRaw.clone().sub(normalWorld.clone().multiplyScalar(tangentWorldRaw.dot(normalWorld))),
          new THREE.Vector3(1, 0, 0)
        );
        const bitangentWorld = normalize(normalWorld.clone().cross(tangentWorld), new THREE.Vector3(0, 0, 1));
        return {
          origin: tuple3(originWorld),
          normal: tuple3(normalWorld),
          tangent: tuple3(tangentWorld),
          bitangent: tuple3(bitangentWorld),
        };
      }
    }

    const transform = getPartTransformOrThrow(feature.part.partId);
    return computeFaceFrame(transform, face);
  }

  if (feature.kind === 'part') {
    const transform = getPartTransformOrThrow(feature.part.partId);
    return {
      origin: transform.position,
      normal: [0, 1, 0],
      tangent: [1, 0, 0],
      bitangent: [0, 0, 1],
    };
  }

  if (feature.kind === 'point') {
    return {
      origin: feature.point,
      normal: [0, 1, 0],
      tangent: [1, 0, 0],
      bitangent: [0, 0, 1],
    };
  }

  if (feature.kind === 'axis') {
    const n = normalize(vec3(feature.axisVector), new THREE.Vector3(0, 1, 0));
    const tangent = normalize(
      Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.95
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0).cross(n),
      new THREE.Vector3(1, 0, 0)
    );
    const bitangent = normalize(n.clone().cross(tangent), new THREE.Vector3(0, 0, 1));
    const transform = getPartTransformOrThrow(feature.part.partId);
    return {
      origin: transform.position,
      normal: tuple3(n),
      tangent: tuple3(tangent),
      bitangent: tuple3(bitangent),
    };
  }

  const transform = getPartTransformOrThrow(feature.part.partId);
  return {
    origin: transform.position,
    normal: [0, 1, 0],
    tangent: [1, 0, 0],
    bitangent: [0, 0, 1],
  };
}

function buildBoundingBox(transform: PartTransform) {
  const position = vec3(transform.position);
  const half = new THREE.Vector3(Math.abs(transform.scale[0]), Math.abs(transform.scale[1]), Math.abs(transform.scale[2])).multiplyScalar(0.5);
  const min = position.clone().sub(half);
  const max = position.clone().add(half);
  return {
    min: tuple3(min),
    max: tuple3(max),
    size: tuple3(half.clone().multiplyScalar(2)),
    center: transform.position,
    space: 'world' as const,
  };
}

function activeSelectionFaceFrame() {
  const active = runtimeState.selection.active;
  if (!active || active.kind !== 'face') return null;
  return featureFrame(active);
}

function resolveTwistAxis(params: {
  axis: 'x' | 'y' | 'z' | 'normal' | 'tangent' | 'bitangent';
  axisSpace: 'world' | 'source_face' | 'target_face';
  sourceFrame?: Frame;
  targetFrame?: Frame;
}) {
  const { axis, axisSpace, sourceFrame, targetFrame } = params;
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  if (axis === 'z') return new THREE.Vector3(0, 0, 1);

  const basis =
    axisSpace === 'source_face' ? sourceFrame : axisSpace === 'target_face' ? targetFrame : activeSelectionFaceFrame();

  if (!basis) {
    return new THREE.Vector3(0, 1, 0);
  }

  if (axis === 'normal') return normalize(vec3(basis.normal), new THREE.Vector3(0, 1, 0));
  if (axis === 'tangent') return normalize(vec3(basis.tangent), new THREE.Vector3(1, 0, 0));
  return normalize(vec3(basis.bitangent), new THREE.Vector3(0, 0, 1));
}

function interpolateTransform(steps: any[], scrubT: number) {
  if (steps.length === 0) {
    return {
      position: ZERO3,
      quaternion: IDENTITY_Q,
      scale: [1, 1, 1] as [number, number, number],
      space: 'world' as const,
    };
  }
  const clamped = Math.max(0, Math.min(1, scrubT));
  const idx = Math.round(clamped * (steps.length - 1));
  const step = steps[idx];
  return {
    position: step.positionWorld,
    quaternion: step.quaternionWorld,
    scale: [1, 1, 1] as [number, number, number],
    space: 'world' as const,
  };
}

function samplePath(params: {
  start: PartTransform;
  end: PartTransform;
  durationMs: number;
  sampleCount: number;
  pathType: 'line' | 'arc' | 'screw';
  arcHeight: number;
  arcLiftAxis?: [number, number, number];
}): Array<{ index: number; timeMs: number; positionWorld: [number, number, number]; quaternionWorld: [number, number, number, number] }> {
  const startPos = vec3(params.start.position);
  const endPos = vec3(params.end.position);
  const startQuat = quat4(params.start.quaternion);
  const endQuat = quat4(params.end.quaternion);
  const samples: Array<{ index: number; timeMs: number; positionWorld: [number, number, number]; quaternionWorld: [number, number, number, number] }> = [];

  const distance = startPos.distanceTo(endPos);
  const autoHeight = Math.max(distance * 0.25, 0.02);
  const arcHeight = Math.abs(params.arcHeight) > 1e-6 ? params.arcHeight : autoHeight;
  const mid = startPos.clone().add(endPos).multiplyScalar(0.5);
  const rawLift = params.arcLiftAxis ? vec3(params.arcLiftAxis) : new THREE.Vector3(0, 1, 0);
  const lift = normalize(rawLift, new THREE.Vector3(0, 1, 0));
  const control = mid.clone().add(lift.multiplyScalar(arcHeight));

  const count = Math.max(2, params.sampleCount);
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    let pos = new THREE.Vector3();
    if (params.pathType === 'arc') {
      const inv = 1 - eased;
      pos = startPos
        .clone()
        .multiplyScalar(inv * inv)
        .add(control.clone().multiplyScalar(2 * inv * eased))
        .add(endPos.clone().multiplyScalar(eased * eased));
    } else {
      pos = startPos.clone().lerp(endPos, eased);
    }

    const q = startQuat.clone().slerp(endQuat, eased).normalize();
    samples.push({
      index,
      timeMs: params.durationMs * t,
      positionWorld: tuple3(pos),
      quaternionWorld: tuple4(q),
    });
  }

  return samples;
}

function computeMateAlignedEndTransform(params: {
  sourceTransform: PartTransform;
  sourceFrame: Frame;
  targetFrame: Frame;
  offset: number;
  clearance: number;
  flip: boolean;
  applyTwist: boolean;
  twistAngleDeg: number;
  twistAxis: 'x' | 'y' | 'z' | 'normal' | 'tangent' | 'bitangent';
  twistAxisSpace: 'world' | 'source_face' | 'target_face';
}) {
  const sourcePos = vec3(params.sourceTransform.position);
  const sourceQuat = quat4(params.sourceTransform.quaternion).normalize();

  const sourceFrameQuat = quaternionFromFrame(params.sourceFrame);

  const targetNormal = normalize(vec3(params.targetFrame.normal), new THREE.Vector3(0, 1, 0));
  const targetTangent = normalize(vec3(params.targetFrame.tangent), new THREE.Vector3(1, 0, 0));
  const wantedNormal = params.flip ? targetNormal : targetNormal.clone().negate();
  const wantedBitangent = normalize(wantedNormal.clone().cross(targetTangent), new THREE.Vector3(0, 0, 1));

  const targetWantedQuat = quaternionFromFrame({
    origin: params.targetFrame.origin,
    normal: tuple3(wantedNormal),
    tangent: tuple3(targetTangent),
    bitangent: tuple3(wantedBitangent),
  });

  const qAlign = targetWantedQuat.clone().multiply(sourceFrameQuat.clone().invert()).normalize();
  let outQuat = qAlign.clone().multiply(sourceQuat).normalize();

  const sourceOrigin = vec3(params.sourceFrame.origin);
  const sourceOffset = sourceOrigin.clone().sub(sourcePos);
  const sourceOriginAfterRotation = sourcePos.clone().add(sourceOffset.clone().applyQuaternion(qAlign));

  const targetOrigin = vec3(params.targetFrame.origin);
  const targetPoint = targetOrigin
    .clone()
    .add(targetNormal.clone().multiplyScalar((params.offset ?? 0) + (params.clearance ?? 0)));
  let outPos = sourcePos.clone().add(targetPoint.clone().sub(sourceOriginAfterRotation));

  let twistAxisWorld = new THREE.Vector3(0, 1, 0);
  if (params.applyTwist) {
    twistAxisWorld = resolveTwistAxis({
      axis: params.twistAxis,
      axisSpace: params.twistAxisSpace,
      sourceFrame: params.sourceFrame,
      targetFrame: params.targetFrame,
    });
    const qTwist = new THREE.Quaternion().setFromAxisAngle(
      normalize(twistAxisWorld, new THREE.Vector3(0, 1, 0)),
      THREE.MathUtils.degToRad(params.twistAngleDeg)
    );
    const pivot = targetOrigin;
    outPos = pivot.clone().add(outPos.clone().sub(pivot).applyQuaternion(qTwist));
    outQuat = qTwist.multiply(outQuat).normalize();
  }

  return {
    endTransform: {
      position: tuple3(outPos),
      quaternion: tuple4(outQuat),
      scale: params.sourceTransform.scale,
      space: 'world' as const,
    },
    debug: {
      sourceFrame: params.sourceFrame,
      targetFrame: params.targetFrame,
      rotationQuat: tuple4(qAlign),
      twistAxisWorld: tuple3(twistAxisWorld),
      twistAngleDeg: params.applyTwist ? params.twistAngleDeg : 0,
      translationWorld: tuple3(outPos.clone().sub(sourcePos)),
    },
  };
}

function worldPoseToLocalPose(
  object: THREE.Object3D,
  worldPos: THREE.Vector3,
  worldQuat: THREE.Quaternion
) {
  const parent = object.parent;
  if (!parent) {
    return { position: tuple3(worldPos), quaternion: tuple4(worldQuat) };
  }

  parent.updateWorldMatrix(true, false);
  const invParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const localPos = worldPos.clone().applyMatrix4(invParent);

  const parentWorldQuat = new THREE.Quaternion();
  parent.getWorldQuaternion(parentWorldQuat);
  const localQuat = parentWorldQuat.invert().multiply(worldQuat).normalize();

  return { position: tuple3(localPos), quaternion: tuple4(localQuat) };
}

function ensurePreviewBeforeTransform(partId: string) {
  if (runtimeState.previewBeforeTransformByPartId.has(partId)) return;
  const transform = getPartTransformOrThrow(partId);
  runtimeState.previewBeforeTransformByPartId.set(partId, {
    position: [...transform.position],
    quaternion: [...transform.quaternion],
    scale: [...transform.scale],
  } as PartTransform);
}

function restorePreviewTransformIfNeeded(partId: string) {
  const before = runtimeState.previewBeforeTransformByPartId.get(partId);
  if (!before) return;
  currentStore().setPartOverrideSilent(partId, before);
  runtimeState.previewBeforeTransformByPartId.delete(partId);
}

function clearPreviewState(partId?: string) {
  if (partId) {
    runtimeState.previewBeforeTransformByPartId.delete(partId);
  }
  runtimeState.preview = null;
}

function previewFromRuntimeOrNull() {
  if (!runtimeState.preview) return null;
  return {
    previewId: runtimeState.preview.previewId,
    planId: runtimeState.preview.planId,
    active: runtimeState.preview.active,
    scrubT: runtimeState.preview.scrubT,
  };
}

function selectFeatureInStore(feature: ResolvedFeature) {
  if (feature.kind === 'part' || feature.kind === 'face' || feature.kind === 'edge' || feature.kind === 'axis' || feature.kind === 'point') {
    currentStore().setSelection(feature.part.partId, 'command');
  }
}

function applyToolSelection(feature: ResolvedFeature, replace: boolean) {
  const current = runtimeState.selection;
  if (replace) {
    runtimeState.selection = { active: feature, stack: [] };
  } else {
    const stack = current.active ? [current.active, ...current.stack].slice(0, 8) : [...current.stack].slice(0, 8);
    runtimeState.selection = { active: feature, stack };
  }
  selectFeatureInStore(feature);
}

function toolListMateModes() {
  return [
    {
      mode: 'face_flush',
      requiredSource: ['face'],
      requiredTarget: ['face'],
      pathType: 'line',
      tunables: ['offset', 'flip', 'twistAngle'],
    },
    {
      mode: 'face_insert_arc',
      requiredSource: ['face'],
      requiredTarget: ['face'],
      pathType: 'arc',
      tunables: ['clearance', 'arcHeight', 'flip', 'twistAngle'],
    },
    {
      mode: 'edge_to_edge',
      requiredSource: ['edge'],
      requiredTarget: ['edge'],
      pathType: 'line',
      tunables: ['offsetAlongEdge', 'flip'],
    },
    {
      mode: 'axis_to_axis',
      requiredSource: ['axis'],
      requiredTarget: ['axis'],
      pathType: 'screw',
      tunables: ['axialOffset', 'radialClearance', 'twistAngle'],
    },
    {
      mode: 'point_to_point',
      requiredSource: ['point'],
      requiredTarget: ['point'],
      pathType: 'line',
      tunables: ['offsetVec'],
    },
    {
      mode: 'planar_slide',
      requiredSource: ['face'],
      requiredTarget: ['face'],
      pathType: 'line',
      tunables: ['slideAxis', 'minRange', 'maxRange'],
    },
    {
      mode: 'hinge_revolute',
      requiredSource: ['axis'],
      requiredTarget: ['axis', 'face'],
      pathType: 'arc',
      tunables: ['angleLimitMin', 'angleLimitMax'],
    },
  ];
}

async function runTool<T extends MCPToolName>(tool: T, args: MCPToolArgs<T>): Promise<ToolEnvelope> {
  if (tool === 'selection.get') {
    return ok({ selection: runtimeState.selection }, { mutating: false });
  }

  if (tool === 'selection.clear') {
    const scope = (args as any).scope ?? 'all';
    if (scope === 'active') {
      runtimeState.selection.active = null;
      currentStore().setSelection(null, 'system');
    } else {
      runtimeState.selection = { active: null, stack: [] };
      currentStore().setSelection(null, 'system');
    }
    return ok({ selection: runtimeState.selection }, { mutating: true });
  }

  if (tool === 'selection.set') {
    const feature = resolveFeature((args as any).selection);
    const replace = (args as any).replace ?? true;
    applyToolSelection(feature, replace);
    return ok(
      {
        selection: runtimeState.selection,
        resolved: feature,
        autoFixes: [],
      },
      { mutating: true }
    );
  }

  if (tool === 'query.scene_state') {
    const store = currentStore();
    const parts = store.parts.order.map((id) => {
      const part = store.parts.byId[id];
      const transform = store.getPartTransform(id) || {
        position: ZERO3,
        quaternion: IDENTITY_Q,
        scale: [1, 1, 1] as [number, number, number],
      };
      return {
        partId: id,
        name: part?.name || id,
        transformWorld: {
          position: transform.position,
          quaternion: transform.quaternion,
          scale: transform.scale,
          space: 'world',
        },
        bboxWorld: buildBoundingBox(transform as PartTransform),
      };
    });

    return ok(
      {
        sceneRevision: runtimeState.sceneRevision,
        parts,
        selection: runtimeState.selection,
        interactionMode: runtimeState.interactionMode,
      },
      { mutating: false }
    );
  }

  if (tool === 'query.part_transform') {
    const part = resolvePart((args as any).part);
    const transform = getPartTransformOrThrow(part.partId);
    return ok(
      {
        part,
        transform: {
          position: transform.position,
          quaternion: transform.quaternion,
          scale: transform.scale,
          space: (args as any).space ?? 'world',
        },
      },
      { mutating: false }
    );
  }

  if (tool === 'query.bounding_box') {
    const part = resolvePart((args as any).part);
    const object = getObjectByPartIdOrThrow(part.partId);
    return ok({ part, boundingBox: worldBoundingBoxFromObject(object) }, { mutating: false });
  }

  if (tool === 'query.face_info') {
    const part = resolvePart((args as any).part);
    const face = (args as any).face;
    const methodRequested = normalizeAnchorMethod((args as any).method, 'planar_cluster');
    const object = getObjectByPartIdOrThrow(part.partId);
    const primary = resolveAnchor({ object, faceId: face, method: methodRequested });
    const fallback =
      primary ??
      (methodRequested === 'geometry_aabb' ? null : resolveAnchor({ object, faceId: face, method: 'geometry_aabb' })) ??
      (methodRequested === 'object_aabb' ? null : resolveAnchor({ object, faceId: face, method: 'object_aabb' }));
    const anchor = primary ?? fallback;
    const methodUsed = normalizeAnchorMethod(anchor?.method, methodRequested);
    const frameWorld = anchor
      ? frameWorldFromAnchor(object, anchor)
      : frameWorldFromAnchor(object, {
          centerLocal: new THREE.Vector3(),
          normalLocal: new THREE.Vector3(0, 1, 0),
        });
    return ok(
      {
        part,
        face,
        frameWorld,
        normalOutward: true,
        methodRequested,
        methodUsed,
        fallbackUsed: Boolean(anchor?.fallbackUsed) || Boolean(primary === null && fallback !== null),
      },
      { mutating: false }
    );
  }

  if (tool === 'query.local_frame') {
    const feature = resolveFeature((args as any).feature);
    return ok({ feature, frame: featureFrame(feature) }, { mutating: false });
  }

  if (tool === 'query.list_mate_modes') {
    return ok({ modes: toolListMateModes() }, { mutating: false });
  }

  if (tool === 'query.model_info') {
    const store = currentStore();
    const verbosity = (args as any).verbosity ?? 'summary';
    const partIds = store.parts.order;
    const partNames = partIds.map((id) => store.parts.byId[id]?.name || id);

    let sceneMin: THREE.Vector3 | null = null;
    let sceneMax: THREE.Vector3 | null = null;

    partIds.forEach((partId) => {
      const transform = store.getPartTransform(partId);
      if (!transform) return;
      const bbox = buildBoundingBox(transform);
      const min = vec3(bbox.min);
      const max = vec3(bbox.max);
      if (!sceneMin || !sceneMax) {
        sceneMin = min;
        sceneMax = max;
        return;
      }
      sceneMin.min(min);
      sceneMax.max(max);
    });

    let sceneBoundingBoxWorld: {
      min: [number, number, number];
      max: [number, number, number];
      size: [number, number, number];
      center: [number, number, number];
      space: 'world';
    } | null = null;
    if (sceneMin !== null && sceneMax !== null) {
      const minVec = sceneMin as THREE.Vector3;
      const maxVec = sceneMax as THREE.Vector3;
      sceneBoundingBoxWorld = {
        min: tuple3(minVec),
        max: tuple3(maxVec),
        size: tuple3(maxVec.clone().sub(minVec)),
        center: tuple3(minVec.clone().add(maxVec).multiplyScalar(0.5)),
        space: 'world',
      };
    }

    return ok(
      {
        model: {
          cadFileName: store.cadFileName || null,
          cadUrl: store.cadUrl || null,
          partCount: partIds.length,
          partNames: verbosity === 'detailed' ? partNames : partNames.slice(0, 20),
          stepCount: store.steps.list.length,
          currentStepId: store.steps.currentStepId,
          selectionPartId: store.selection.partId,
          interactionMode: store.interaction.mode,
          sceneBoundingBoxWorld,
        },
      },
      { mutating: false }
    );
  }

  if (tool === 'query.mate_suggestions') {
    const input = args as any;
    const source = resolvePart(input.sourcePart);
    const target = resolvePart(input.targetPart);
    const instruction = normalizeInstructionText(input.instruction);

    const sourceObject = getObjectByPartIdOrThrow(source.partId);
    const targetObject = getObjectByPartIdOrThrow(target.partId);

    // Use combined group bounding box when the part is a group representative,
    // so that face-pair inference uses the full group geometry, not just one part.
    const suggestStore = currentStore();
    const srcGrpId = suggestStore.getGroupForPart(source.partId);
    const tgtGrpId = suggestStore.getGroupForPart(target.partId);
    const buildGroupBox = (partIds: string[]) => {
      const box = new THREE.Box3();
      for (const pid of partIds) {
        const obj = getV2ObjectByPartId(pid);
        if (obj) { const b = new THREE.Box3().setFromObject(obj); if (!b.isEmpty()) box.union(b); }
      }
      return box;
    };
    const srcBox = srcGrpId
      ? buildGroupBox(suggestStore.getGroupParts(srcGrpId))
      : new THREE.Box3().setFromObject(sourceObject);
    const tgtBox = tgtGrpId
      ? buildGroupBox(suggestStore.getGroupParts(tgtGrpId))
      : new THREE.Box3().setFromObject(targetObject);

    const sourceBoxWorld = srcBox.isEmpty() ? worldBoundingBoxFromObject(sourceObject) : {
      min: tuple3(srcBox.min), max: tuple3(srcBox.max),
      size: tuple3(srcBox.getSize(new THREE.Vector3())),
      center: tuple3(srcBox.getCenter(new THREE.Vector3())), space: 'world' as const,
    };
    const targetBoxWorld = tgtBox.isEmpty() ? worldBoundingBoxFromObject(targetObject) : {
      min: tuple3(tgtBox.min), max: tuple3(tgtBox.max),
      size: tuple3(tgtBox.getSize(new THREE.Vector3())),
      center: tuple3(tgtBox.getCenter(new THREE.Vector3())), space: 'world' as const,
    };

    const sourceCenter = vec3(sourceBoxWorld.center);
    const targetCenter = vec3(targetBoxWorld.center);

    const geometryIntent = inferIntentFromGeometry(sourceObject, targetObject);

    // For insert, canonical expected pair is bottom→top (cavity opening is local +Y of target).
    // For other intents, use center-to-center direction.
    const expectedFromCenters: { sourceFace: StoreFaceId; targetFace: StoreFaceId } =
      geometryIntent === 'insert'
        ? { sourceFace: 'bottom', targetFace: 'top' }
        : getExpectedFacePairFromCenters(sourceCenter, targetCenter);

    // Build geometry hint for LLM context.
    const geometryHint = {
      expectedFacePair: expectedFromCenters,
      sourceBboxSize: sourceBoxWorld.size as [number, number, number],
      targetBboxSize: targetBoxWorld.size as [number, number, number],
      relativePosition: {
        dx: targetCenter.x - sourceCenter.x,
        dy: targetCenter.y - sourceCenter.y,
        dz: targetCenter.z - sourceCenter.z,
      },
    };

    // Ask LLM for semantic intent/mode/method decisions.
    const agentParams = await callAgentForMateParams({
      userText: instruction,
      sourcePart: { id: source.partId, name: source.partName },
      targetPart: { id: target.partId, name: target.partName },
      geometryHint,
    });

    // LLM primary; geometry fallback when LLM unavailable (e.g. mock/test mode).
    const geometryFallbackIntent = agentParams === null
      ? inferIntentFromGeometryFallback(sourceObject, targetObject)
      : null;
    const intentKind: MateIntentKind =
      agentParams?.intent ?? geometryFallbackIntent ?? geometryIntent ?? 'default';
    const suggestedMode: MateExecMode =
      agentParams?.mode ?? defaultModeForIntent(intentKind);

    // Explicit method override from instruction text takes priority over LLM.
    const instructionMethod = methodFromInstruction(instruction);
    const explicitSourceMethod =
      typeof input.sourceMethod === 'string' && input.sourceMethod !== 'auto'
        ? (input.sourceMethod as AnchorMethodId)
        : parseExplicitAnchorMethod(input.sourceMethod);
    const explicitTargetMethod =
      typeof input.targetMethod === 'string' && input.targetMethod !== 'auto'
        ? (input.targetMethod as AnchorMethodId)
        : parseExplicitAnchorMethod(input.targetMethod);

    // LLM-provided methods are used as first priority if no explicit override.
    const llmSourceMethod = agentParams?.sourceMethod ?? null;
    const llmTargetMethod = agentParams?.targetMethod ?? null;

    const sourceMethods = buildMethodPriority({
      explicit: explicitSourceMethod ?? (instructionMethod ?? llmSourceMethod),
      instructionMethod: null,
      intent: intentKind,
      role: 'source',
    });
    const targetMethods = buildMethodPriority({
      explicit: explicitTargetMethod ?? (instructionMethod ?? llmTargetMethod),
      instructionMethod: null,
      intent: intentKind,
      role: 'target',
    });

    const preferredSourceFace =
      STORE_FACES.includes(input.preferredSourceFace as StoreFaceId)
        ? (input.preferredSourceFace as StoreFaceId)
        : (agentParams?.sourceFace ?? null);
    const preferredTargetFace =
      STORE_FACES.includes(input.preferredTargetFace as StoreFaceId)
        ? (input.preferredTargetFace as StoreFaceId)
        : (agentParams?.targetFace ?? null);
    const maxPairs = Number(input.maxPairs ?? 12);

    const suggestion = inferBestFacePair({
      sourceObject,
      targetObject,
      sourceMethods,
      targetMethods,
      preferredSourceFace,
      preferredTargetFace,
      limit: Number.isFinite(maxPairs) ? Math.max(1, Math.min(36, Math.floor(maxPairs))) : 12,
      intent: intentKind,
    });

    return ok(
      {
        source,
        target,
        intent: intentKind,
        suggestedMode,
        expectedFromCenters,
        sourceBoxWorld,
        targetBoxWorld,
        ranking: suggestion?.ranking ?? [],
      },
      {
        mutating: false,
        debug: {
          notes: [
            'Mate suggestions computed from live scene geometry + LLM inference',
            `intent=${intentKind}`,
            `geometry_intent=${geometryIntent ?? 'none'}`,
            `llm_confidence=${agentParams?.confidence ?? 'n/a'}`,
            `instruction_method=${instructionMethod ?? 'none'}`,
          ],
          llmReasoning: agentParams?.reasoning,
        },
      }
    );
  }

  if (tool === 'query.mate_vlm_infer') {
    const input = args as any;
    const source = resolvePart(input.sourcePart);
    const target = resolvePart(input.targetPart);
    if (source.partId === target.partId) {
      throw new ToolExecutionError({
        code: 'INVALID_ARGUMENT',
        message: 'sourcePart and targetPart must be different parts',
      });
    }

    const instruction = normalizeInstructionText(input.instruction);
    const preferredSourceFace =
      STORE_FACES.includes(input.preferredSourceFace as StoreFaceId)
        ? (input.preferredSourceFace as StoreFaceId)
        : undefined;
    const preferredTargetFace =
      STORE_FACES.includes(input.preferredTargetFace as StoreFaceId)
        ? (input.preferredTargetFace as StoreFaceId)
        : undefined;
    const explicitSourceMethod = parseExplicitAnchorMethod(input.sourceMethod) ?? undefined;
    const explicitTargetMethod = parseExplicitAnchorMethod(input.targetMethod) ?? undefined;
    const preferredMode =
      typeof input.preferredMode === 'string' && ['translate', 'twist', 'both'].includes(input.preferredMode)
        ? (input.preferredMode as MateExecMode)
        : undefined;

    const suggestionEnvelope = await runTool('query.mate_suggestions' as MCPToolName, {
      sourcePart: { partId: source.partId },
      targetPart: { partId: target.partId },
      instruction,
      ...(preferredSourceFace ? { preferredSourceFace } : {}),
      ...(preferredTargetFace ? { preferredTargetFace } : {}),
      sourceMethod: normalizeAnchorMethod(input.sourceMethod, 'planar_cluster'),
      targetMethod: normalizeAnchorMethod(input.targetMethod, 'planar_cluster'),
      maxPairs: clampInt(Number(input.maxPairs ?? 12), 1, 36),
    });
    const suggestionData = unwrapToolData(suggestionEnvelope, 'SOLVER_FAILED') as any;

    const sourceObject = getObjectByPartIdOrThrow(source.partId);
    const targetObject = getObjectByPartIdOrThrow(target.partId);

    // Detect rotation mismatch: if source and target have different world orientations,
    // face normals won't align via translation alone → mode='both' is required.
    const sourceWorldQuat = sourceObject.getWorldQuaternion(new THREE.Quaternion());
    const targetWorldQuat = targetObject.getWorldQuaternion(new THREE.Quaternion());
    const quatDot = Math.abs(sourceWorldQuat.dot(targetWorldQuat));
    const rotationMismatchDeg = Math.acos(Math.min(1, quatDot)) * 2 * (180 / Math.PI);
    const hasRotationMismatch = rotationMismatchDeg > 5;

    const viewStore = currentStore();
    const prevAnchorsVisible = Boolean(viewStore.view.showAnchors);
    if (!prevAnchorsVisible) viewStore.setAnchorsVisible(true);

    // Determine if source/target are representative parts of assembly groups.
    // When they are, keep ALL group members visible and compute combined BBoxes
    // so the capture frames the entire group, not just the representative part.
    const sourceGroupId = viewStore.getGroupForPart(source.partId);
    const targetGroupId = viewStore.getGroupForPart(target.partId);
    const sourceGroupPartIds = sourceGroupId ? viewStore.getGroupParts(sourceGroupId) : [source.partId];
    const targetGroupPartIds = targetGroupId ? viewStore.getGroupParts(targetGroupId) : [target.partId];
    const visibleIds = new Set([...sourceGroupPartIds, ...targetGroupPartIds]);

    const sourceLabel = sourceGroupId
      ? (viewStore.assemblyGroups.byId[sourceGroupId]?.name ?? source.partName)
      : source.partName;
    const targetLabel = targetGroupId
      ? (viewStore.assemblyGroups.byId[targetGroupId]?.name ?? target.partName)
      : target.partName;

    // Compute combined world BBox for each group (union of all member boxes)
    const computeGroupBox = (partIds: string[]): THREE.Box3 => {
      const box = new THREE.Box3();
      for (const pid of partIds) {
        const obj = getV2ObjectByPartId(pid);
        if (obj) {
          const mBox = new THREE.Box3().setFromObject(obj);
          if (!mBox.isEmpty()) box.union(mBox);
        }
      }
      return box;
    };
    const sourceBoxOverride = sourceGroupPartIds.length > 1 ? computeGroupBox(sourceGroupPartIds) : undefined;
    const targetBoxOverride = targetGroupPartIds.length > 1 ? computeGroupBox(targetGroupPartIds) : undefined;

    // Hide all parts that are not part of either group
    const otherPartIds = viewStore.parts.order.filter(id => !visibleIds.has(id));
    const otherObjects = otherPartIds
      .map(id => getV2ObjectByPartId(id))
      .filter((o): o is THREE.Object3D => o !== null);
    const prevVisibilities = otherObjects.map(o => o.visible);
    otherObjects.forEach(o => { o.visible = false; });

    let capture: ReturnType<typeof buildMateCaptureImages>;
    try {
      capture = buildMateCaptureImages({
        sourceObject,
        targetObject,
        sourceLabel,
        targetLabel,
        maxViews: clampInt(Number(input.maxViews ?? 4), 2, 12),
        maxWidthPx: clampInt(Number(input.maxWidthPx ?? 640), 64, 2048),
        maxHeightPx: clampInt(Number(input.maxHeightPx ?? 480), 64, 2048),
        format: String(input.format || 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg',
        jpegQuality: Number.isFinite(Number(input.jpegQuality)) ? Number(input.jpegQuality) : 0.9,
        sourceBoxOverride,
        targetBoxOverride,
      });
    } finally {
      otherObjects.forEach((o, i) => { o.visible = prevVisibilities[i]; });
      if (!prevAnchorsVisible) viewStore.setAnchorsVisible(prevAnchorsVisible);
    }
    const overlayImages = capture.images.map((image, index) => ({
      id: `${Date.now()}-${index}-${image.name}`,
      name: image.name,
      label: image.label,
      dataUrl: `data:${image.mime};base64,${image.dataBase64}`,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      mime: image.mime,
    }));
    if (overlayImages.length > 0) {
      viewStore.showMateCaptureOverlay(overlayImages, 5000);
    }

    const ranking = Array.isArray(suggestionData?.ranking) ? suggestionData.ranking : [];
    const rankingTop = ranking[0] && typeof ranking[0] === 'object' ? ranking[0] : null;
    const geometryIntent = (['default', 'cover', 'insert'].includes(String(suggestionData?.intent))
      ? (suggestionData.intent as MateIntentKind)
      : 'default') as MateIntentKind;
    const geometryMode = (preferredMode ||
      (hasRotationMismatch ? 'both' :
        (['translate', 'twist', 'both'].includes(String(suggestionData?.suggestedMode))
          ? (suggestionData.suggestedMode as MateExecMode)
          : defaultModeForIntent(geometryIntent)))) as MateExecMode;
    const expectedFromCenters = suggestionData?.expectedFromCenters || {
      sourceFace: 'bottom',
      targetFace: 'top',
    };

    // Feature-First Intent Router: map instruction + geometry intent → preferred feature paths.
    // The routing decision biases candidateRows scoring (additive, never replaces existing signals).
    const intentRouting = routeAssemblyIntent({
      instruction,
      sourceName: source.partName,
      targetName: target.partName,
      geometryIntent,
    });
    console.log(`[intent-router] intent=${intentRouting.assemblyIntent} mode=${intentRouting.usedFeatureMode} diag=[${intentRouting.routingDiagnostics.join(' | ')}]`);

    const geometrySourceFace = preferredSourceFace || (rankingTop?.sourceFace as StoreFaceId | undefined) || (expectedFromCenters.sourceFace as StoreFaceId) || 'bottom';
    const geometryTargetFace = preferredTargetFace || (rankingTop?.targetFace as StoreFaceId | undefined) || (expectedFromCenters.targetFace as StoreFaceId) || 'top';
    const geometrySourceMethod = normalizeAnchorMethod(
      explicitSourceMethod || (rankingTop?.sourceMethod as AnchorMethodId | undefined),
      'planar_cluster'
    );
    const geometryTargetMethod = normalizeAnchorMethod(
      explicitTargetMethod || (rankingTop?.targetMethod as AnchorMethodId | undefined),
      'planar_cluster'
    );

    const isFaceId = (value: unknown): value is StoreFaceId =>
      typeof value === 'string' && STORE_FACES.includes(value as StoreFaceId);
    const isMethodId = (value: unknown): value is AnchorMethodId => isExecutableAnchorMethod(value);
    const facePairAxis = (sourceFace: StoreFaceId, targetFace: StoreFaceId): 'x' | 'y' | 'z' | 'mixed' => {
      if ((sourceFace === 'left' && targetFace === 'right') || (sourceFace === 'right' && targetFace === 'left')) return 'x';
      if ((sourceFace === 'top' && targetFace === 'bottom') || (sourceFace === 'bottom' && targetFace === 'top')) return 'y';
      if ((sourceFace === 'front' && targetFace === 'back') || (sourceFace === 'back' && targetFace === 'front')) return 'z';
      return 'mixed';
    };
    const getDominantFacesForVlm = (obj: THREE.Object3D, worldQuat: THREE.Quaternion, topN = 3) => {
      const allClusters: ReturnType<typeof clusterPlanarFaces> = [];
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
          allClusters.push(...clusterPlanarFaces(child.geometry));
        }
      });
      allClusters.sort((a, b) => b.area - a.area);
      const totalArea = allClusters.reduce((s, c) => s + c.area, 0) || 1;
      const upWorld = new THREE.Vector3(0, 1, 0);
      return allClusters.slice(0, topN).map((c) => {
        const normalWorld = c.normal.clone().applyQuaternion(worldQuat);
        const yDot = normalWorld.dot(upWorld);
        const face =
          yDot > 0.7 ? 'top' :
          yDot < -0.7 ? 'bottom' :
          Math.abs(normalWorld.x) > Math.abs(normalWorld.z)
            ? (normalWorld.x > 0 ? 'right' : 'left')
            : (normalWorld.z > 0 ? 'front' : 'back');
        return {
          face,
          areaRatio: Number((c.area / totalArea).toFixed(4)),
          normalWorld: normalWorld.toArray().map((v) => Number(v.toFixed(4))),
        };
      });
    };
    const overlap1d = (aMin: number, aMax: number, bMin: number, bMax: number) => {
      const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
      const base = Math.max(1e-6, Math.min(aMax - aMin, bMax - bMin));
      return overlap / base;
    };

    const sourceCenterRaw = capture.sourceCenter;
    const targetCenterRaw = capture.targetCenter;
    const sourceSizeRaw = tuple3(getIntrinsicSizeFromObject(sourceObject));
    const targetSizeRaw = tuple3(getIntrinsicSizeFromObject(targetObject));
    const centerDelta = {
      x: Number(targetCenterRaw[0] ?? 0) - Number(sourceCenterRaw[0] ?? 0),
      y: Number(targetCenterRaw[1] ?? 0) - Number(sourceCenterRaw[1] ?? 0),
      z: Number(targetCenterRaw[2] ?? 0) - Number(sourceCenterRaw[2] ?? 0),
    };
    const overlapX = overlap1d(
      Number(sourceCenterRaw[0] ?? 0) - Math.abs(Number(sourceSizeRaw[0] ?? 0)) * 0.5,
      Number(sourceCenterRaw[0] ?? 0) + Math.abs(Number(sourceSizeRaw[0] ?? 0)) * 0.5,
      Number(targetCenterRaw[0] ?? 0) - Math.abs(Number(targetSizeRaw[0] ?? 0)) * 0.5,
      Number(targetCenterRaw[0] ?? 0) + Math.abs(Number(targetSizeRaw[0] ?? 0)) * 0.5
    );
    const overlapY = overlap1d(
      Number(sourceCenterRaw[1] ?? 0) - Math.abs(Number(sourceSizeRaw[1] ?? 0)) * 0.5,
      Number(sourceCenterRaw[1] ?? 0) + Math.abs(Number(sourceSizeRaw[1] ?? 0)) * 0.5,
      Number(targetCenterRaw[1] ?? 0) - Math.abs(Number(targetSizeRaw[1] ?? 0)) * 0.5,
      Number(targetCenterRaw[1] ?? 0) + Math.abs(Number(targetSizeRaw[1] ?? 0)) * 0.5
    );
    const overlapZ = overlap1d(
      Number(sourceCenterRaw[2] ?? 0) - Math.abs(Number(sourceSizeRaw[2] ?? 0)) * 0.5,
      Number(sourceCenterRaw[2] ?? 0) + Math.abs(Number(sourceSizeRaw[2] ?? 0)) * 0.5,
      Number(targetCenterRaw[2] ?? 0) - Math.abs(Number(targetSizeRaw[2] ?? 0)) * 0.5,
      Number(targetCenterRaw[2] ?? 0) + Math.abs(Number(targetSizeRaw[2] ?? 0)) * 0.5
    );
    const combinedYSize = Math.abs(Number(sourceSizeRaw[1] ?? 0)) + Math.abs(Number(targetSizeRaw[1] ?? 0));
    const stackedLikely =
      Math.abs(centerDelta.y) > (Math.abs(Number(sourceSizeRaw[1] ?? 0)) + Math.abs(Number(targetSizeRaw[1] ?? 0))) * 0.22 &&
      overlapX > 0.4 &&
      overlapZ > 0.4;
    const sourceAboveTarget = centerDelta.y < -(combinedYSize * 0.12);
    const sourceBelowTarget = centerDelta.y > combinedYSize * 0.12;
    const ySeparated = sourceAboveTarget || sourceBelowTarget;

    const candidateRows = ranking.slice(0, 8).flatMap((row: any, rankIndex: number) => {
      if (!row || typeof row !== 'object') return [];
      if (!isFaceId(row.sourceFace) || !isFaceId(row.targetFace)) return [];
      if (!isMethodId(row.sourceMethod) || !isMethodId(row.targetMethod)) return [];
      const axis = facePairAxis(row.sourceFace, row.targetFace);
      const verticalPair = axis === 'y';
      const lateralPair = axis === 'x' || axis === 'z';
      let semanticScore = Number.isFinite(Number(row.score)) ? Number(row.score) : 0;
      const tags: string[] = [];
      if (verticalPair) tags.push('vertical_pair');
      if (lateralPair) tags.push('lateral_pair');
      if (row.sourceFace === 'bottom' && row.targetFace === 'top') tags.push('bottom_to_top');
      if (row.sourceFace === 'top' && row.targetFace === 'bottom') tags.push('top_to_bottom');
      if (row.sourceMethod === 'planar_cluster' || row.targetMethod === 'planar_cluster') tags.push('planar_cluster');
      if (geometryIntent === 'cover') {
        if (verticalPair) {
          semanticScore += 0.22;
          tags.push('cover_friendly');
          if (stackedLikely) semanticScore += 0.08;
        }
        if (lateralPair) semanticScore -= 0.12;
      }
      if (geometryIntent === 'insert') {
        if (row.targetMethod !== 'object_aabb') {
          semanticScore += 0.08;
          tags.push('insert_friendly');
        } else {
          semanticScore -= 0.06;
        }
        if (verticalPair) {
          semanticScore += 0.12;
          tags.push('insert_vertical_pair');
          if (row.sourceFace === 'bottom' && row.targetFace === 'top') {
            semanticScore += 0.08;
            tags.push('insert_downward_pair');
          }
        } else if (lateralPair) {
          semanticScore -= 0.04;
        }
      }
      if (geometryIntent === 'default') {
        // Spark domain rule: ALL assemblies use Y-axis — always prefer vertical pairs
        const verticalBias = parseFloat(import.meta.env.VITE_ASSEMBLY_VERTICAL_BIAS ?? '0.20');
        if (verticalPair) {
          semanticScore += verticalBias;
          tags.push('default_vertical_bias');
          if (row.sourceFace === 'bottom' && row.targetFace === 'top') {
            semanticScore += 0.08; // strongest preference: bottom→top
            tags.push('bottom_to_top_preferred');
          }
        }
        if (lateralPair) semanticScore -= 0.10; // penalize lateral when intent is default
      }

      // Issue 1: Rotation-aware scoring.
      // When parts have a significant rotation mismatch, the world-space face name
      // (top/bottom/left/right) from bbox analysis is unreliable — the part's local
      // "top" may point sideways in world space.  Reduce face-name vertical bias and
      // instead reward methods that anchor on physical geometry (planar_cluster / obb_pca).
      if (hasRotationMismatch) {
        // Discount the generic vertical preference — geometry is warped
        if (verticalPair && geometryIntent === 'default') {
          semanticScore -= 0.08;
          tags.push('rotation_mismatch_vertical_discount');
        }
        // Prefer geometry-driven methods (they are rotation-invariant)
        const usesGeomMethod = (row.sourceMethod === 'planar_cluster' || row.sourceMethod === 'obb_pca') &&
          (row.targetMethod === 'planar_cluster' || row.targetMethod === 'obb_pca');
        if (usesGeomMethod) {
          semanticScore += 0.12;
          tags.push('rotation_mismatch_geom_method_bonus');
        }
        // For fan-like parts specifically, prefer pattern/hole alignment when rotated
        if (/fan|FAN|風扇/i.test(source.partName) || /fan|FAN|風扇/i.test(target.partName)) {
          if (row.sourceMethod === 'planar_cluster' && row.targetMethod === 'planar_cluster') {
            semanticScore += 0.08;
            tags.push('rotation_mismatch_fan_pattern_bonus');
          }
        }
      }

      // Fix C: Anti-self-stack for fan-like parts.
      // When source AND target are both fans, penalise top/bottom stacking and
      // prefer lateral or pattern-align-compatible faces instead.
      const srcFanLike = /fan|FAN|風扇/i.test(source.partName);
      const tgtFanLike = /fan|FAN|風扇/i.test(target.partName);
      if (srcFanLike && tgtFanLike) {
        if (verticalPair) {
          semanticScore -= 0.30;
          tags.push('fan_selfstack_vertical_penalty');
        }
        if (lateralPair) {
          semanticScore += 0.20;
          tags.push('fan_lateral_bonus');
        }
        // Reward methods likely to use hole patterns (fans have mounting holes)
        if (row.sourceMethod === 'planar_cluster' && row.targetMethod === 'planar_cluster') {
          semanticScore += 0.10;
          tags.push('fan_pattern_compatible_methods');
        }
      }

      // Fix E: Mount-to-structural-target face preference.
      // When source is fan-like and target is a structural part (thermal/chassis/board),
      // prefer target top/front faces and penalise bottom face.
      const tgtStructural = /thermal|chassis|board|motherboard|base|frame|housing/i.test(target.partName);
      if (srcFanLike && tgtStructural) {
        if (row.targetFace === 'bottom') {
          semanticScore -= 0.12;
          tags.push('mount_target_bottom_penalty');
        }
        if (row.targetFace === 'top') {
          semanticScore += 0.14;
          tags.push('mount_target_top_bonus');
        }
        // Reward planar_cluster on target (flat mounting surface)
        if (row.targetMethod === 'planar_cluster') {
          semanticScore += 0.08;
          tags.push('mount_planar_cluster_bonus');
        }
      }

      // Fix B: Feature-first mount path for fan → structural target.
      // When a fan is mounted onto a thermal/chassis/board, require the solver to
      // anchor on actual geometric clusters (planar_cluster / obb_pca) rather than
      // bounding-box faces (object_aabb / geometry_aabb). This ensures alignment to
      // screw-hole / standoff / peg regions rather than generic flat faces.
      if (srcFanLike && tgtStructural) {
        const srcFeatureMethod = row.sourceMethod === 'planar_cluster' || row.sourceMethod === 'obb_pca';
        const tgtFeatureMethod = row.targetMethod === 'planar_cluster' || row.targetMethod === 'obb_pca';
        if (srcFeatureMethod && tgtFeatureMethod) {
          semanticScore += 0.25;
          tags.push('feature_first_mount');
        } else if (row.targetMethod === 'object_aabb' || row.targetMethod === 'geometry_aabb') {
          // Generic bbox anchor on target — would align to flat face centroid, not features
          semanticScore -= 0.22;
          tags.push('planar_fallback_penalty');
        }
      }

      if (
        preferredSourceFace &&
        preferredTargetFace &&
        row.sourceFace === preferredSourceFace &&
        row.targetFace === preferredTargetFace
      ) {
        semanticScore += 0.35;
        tags.push('explicit_face_match');
      }

      // Feature-First Intent Router adjustments (additive, never replaces existing signals).
      // mount → rewards feature-extracting methods; penalizes bbox-only anchor.
      // insert → same but with insert-specific weights.
      // cover → modest extra vertical bonus; smaller bbox penalty.
      // default → no change (fallback_generic = zero delta).
      {
        const { delta, tags: routeTags } = applyRoutingAdjustments(
          intentRouting,
          { sourceMethod: row.sourceMethod, targetMethod: row.targetMethod },
          verticalPair,
          lateralPair,
        );
        if (delta !== 0) semanticScore += delta;
        tags.push(...routeTags);
      }

      return [
        {
          candidateIndex: rankIndex,
          candidateKey: `${row.sourceFace}:${row.targetFace}:${row.sourceMethod}:${row.targetMethod}`,
          sourceFace: row.sourceFace as StoreFaceId,
          targetFace: row.targetFace as StoreFaceId,
          sourceMethod: normalizeAnchorMethod(row.sourceMethod, 'planar_cluster'),
          targetMethod: normalizeAnchorMethod(row.targetMethod, 'planar_cluster'),
          score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
          semanticScore,
          tags,
        },
      ];
    });
    const candidateRowsBySemantic = [...candidateRows].sort((a, b) => b.semanticScore - a.semanticScore);

    // Post-sort: detect whether the top candidate used feature-extracting methods or fell back to bbox.
    intentRouting.fallbackUsed = detectFallbackUsed(candidateRowsBySemantic[0]);
    if (intentRouting.fallbackUsed && intentRouting.usedFeatureMode !== 'fallback_generic') {
      console.log(`[intent-router] fallback_used=true — top candidate is bbox-based despite intent=${intentRouting.assemblyIntent}`);
    }

    // Fix B post-sort: ensure feature_first_mount wins over planar_fallback when both exist.
    // If the top candidate has planar_fallback_penalty but a feature_first_mount candidate
    // exists, swap the feature candidate to top so the solver uses the geometric anchor.
    const srcFanForMount = /fan|FAN|風扇/i.test(source.partName);
    const tgtStructForMount = /thermal|chassis|board|motherboard|base|frame|housing|cover/i.test(target.partName);
    if (srcFanForMount && tgtStructForMount && candidateRowsBySemantic.length > 1) {
      const topHasPlanarFallback = candidateRowsBySemantic[0].tags.includes('planar_fallback_penalty');
      if (topHasPlanarFallback) {
        const featureIdx = candidateRowsBySemantic.findIndex(c => c.tags.includes('feature_first_mount'));
        if (featureIdx > 0) {
          const [featureCand] = candidateRowsBySemantic.splice(featureIdx, 1);
          candidateRowsBySemantic.unshift(featureCand);
        }
      }
    }

    const store = currentStore();
    const partsCtx = store.parts.order.map((id) => ({ id, name: store.parts.byId[id]?.name || id }));
    const mateContext = {
      instruction,
      sourcePartId: source.partId,
      sourcePartName: source.partName,
      targetPartId: target.partId,
      targetPartName: target.partName,
      explicitHints: {
        preferredSourceFace: preferredSourceFace ?? null,
        preferredTargetFace: preferredTargetFace ?? null,
        sourceMethod: explicitSourceMethod ?? null,
        targetMethod: explicitTargetMethod ?? null,
        preferredMode: preferredMode ?? null,
      },
      intentRouting: {
        assemblyIntent: intentRouting.assemblyIntent,
        usedFeatureMode: intentRouting.usedFeatureMode,
        preferredFeatureTypes: intentRouting.preferredFeatureTypes,
        preferredSolverFamilies: intentRouting.preferredSolverFamilies,
        fallbackAllowed: intentRouting.fallbackAllowed,
        fallbackUsed: intentRouting.fallbackUsed ?? false,
        routingDiagnostics: intentRouting.routingDiagnostics,
      },
      geometry: {
        intent: geometryIntent,
        suggestedMode: geometryMode,
        expectedFromCenters: {
          sourceFace: geometrySourceFace,
          targetFace: geometryTargetFace,
        },
        rankingTop: rankingTop
          ? {
              sourceFace: rankingTop.sourceFace,
              targetFace: rankingTop.targetFace,
              sourceMethod: rankingTop.sourceMethod,
              targetMethod: rankingTop.targetMethod,
              score: rankingTop.score,
            }
          : null,
        rankingTopN: ranking.slice(0, 6).map((row: any) => ({
          sourceFace: row?.sourceFace,
          targetFace: row?.targetFace,
          sourceMethod: row?.sourceMethod,
          targetMethod: row?.targetMethod,
          score: row?.score,
        })),
        candidates: candidateRowsBySemantic.map((candidate) => ({
          candidateIndex: candidate.candidateIndex,
          candidateKey: candidate.candidateKey,
          sourceFace: candidate.sourceFace,
          targetFace: candidate.targetFace,
          sourceMethod: candidate.sourceMethod,
          targetMethod: candidate.targetMethod,
          score: candidate.score,
          semanticScore: candidate.semanticScore,
          tags: candidate.tags,
        })),
        sourceDominantFaces: getDominantFacesForVlm(sourceObject, sourceWorldQuat),
        targetDominantFaces: getDominantFacesForVlm(targetObject, targetWorldQuat),
      },
      sceneRelation: {
        sourceCenter: capture.sourceCenter,
        targetCenter: capture.targetCenter,
        pairCenter: capture.pairCenter,
        pairSize: capture.pairSize,
        pairIntrinsicSize: capture.pairIntrinsicSize,
        pairDistance: capture.pairDistance,
        sourceQuaternion: [sourceWorldQuat.x, sourceWorldQuat.y, sourceWorldQuat.z, sourceWorldQuat.w] as [number,number,number,number],
        targetQuaternion: [targetWorldQuat.x, targetWorldQuat.y, targetWorldQuat.z, targetWorldQuat.w] as [number,number,number,number],
        rotationMismatchDeg: Number(rotationMismatchDeg.toFixed(2)),
        hasRotationMismatch,
      },
      captureFrame: capture.captureFrame,
      captureViews: capture.images.map((img) => ({
        name: img.name,
        label: img.label,
        widthPx: img.widthPx,
        heightPx: img.heightPx,
        cameraPose: img.cameraPose,
      })),
    };

    let vlmResult: any = null;
    let vlmError: string | null = null;
    try {
      const res: any = await v2Client.request('vlm_analyze', {
        images: capture.images.map((img) => ({
          name: img.name,
          mime: img.mime,
          data: img.dataBase64,
        })),
        parts: partsCtx,
        mateContext,
      }, { timeoutMs: 130_000 });
      vlmResult = res?.result || res;
    } catch (error: any) {
      vlmError = error?.message || 'vlm_analyze failed';
    }

    const asFace = (value: unknown) =>
      typeof value === 'string' && STORE_FACES.includes(value as StoreFaceId) ? (value as StoreFaceId) : undefined;
    const asMethod = (value: unknown) => {
      if (typeof value !== 'string') return undefined;
      return normalizeAnchorMethod(value, 'planar_cluster');
    };
    const asMode = (value: unknown) =>
      typeof value === 'string' && ['translate', 'twist', 'both'].includes(value) ? (value as MateExecMode) : undefined;
    const asIntent = (value: unknown) =>
      typeof value === 'string' && ['default', 'cover', 'insert'].includes(value) ? (value as MateIntentKind) : undefined;
    const asConfidence = (value: unknown) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return Math.max(0, Math.min(1, n));
    };
    const asShortString = (value: unknown) =>
      typeof value === 'string' ? value.trim().slice(0, 180) : undefined;

    const rawMate = vlmResult && typeof vlmResult === 'object' ? (vlmResult as any).mate_inference : null;
    const rawMateDiagnostics = rawMate && typeof rawMate === 'object' && rawMate.diagnostics && typeof rawMate.diagnostics === 'object'
      ? (rawMate.diagnostics as Record<string, unknown>)
      : null;
    const vlmConfidence = asConfidence(rawMate?.confidence);
    const viewWeightForName = (name: string) => {
      const lower = name.toLowerCase();
      if (lower.includes('source_to_target') || lower.includes('target_to_source')) return 1.25;
      if (lower.includes('top')) return 1.15;
      if (lower.includes('overview')) return 0.8;
      if (lower.includes('front') || lower.includes('right')) return 0.9;
      return 1.0;
    };
    const rawViewVotes = Array.isArray(rawMate?.view_votes) ? rawMate.view_votes : [];
    const parsedViewVotes = rawViewVotes
      .map((vote: any) => {
        const viewName = asShortString(vote?.view_name);
        const candidateIndex = Number.isInteger(Number(vote?.candidate_index)) ? Number(vote.candidate_index) : undefined;
        const candidateKey = asShortString(vote?.candidate_key);
        const confidence = asConfidence(vote?.confidence);
        if (!viewName) return null;
        return {
          viewName,
          candidateIndex,
          candidateKey,
          confidence,
          reason: asShortString(vote?.reason),
          weight: viewWeightForName(viewName) * Math.max(0.2, confidence ?? 0.5),
        };
      })
      .filter(Boolean) as Array<{
      viewName: string;
      candidateIndex?: number;
      candidateKey?: string;
      confidence?: number;
      reason?: string;
      weight: number;
    }>;
    const parsedVlmDiagnostics = rawMateDiagnostics
      ? {
          provider: asShortString(rawMateDiagnostics.provider),
          repairAttempts:
            typeof rawMateDiagnostics.repair_attempts === 'number' && Number.isFinite(rawMateDiagnostics.repair_attempts)
              ? Math.max(0, Math.floor(Number(rawMateDiagnostics.repair_attempts)))
              : undefined,
          fallbackUsed: rawMateDiagnostics.fallback_used === true ? true : rawMateDiagnostics.fallback_used === false ? false : undefined,
          providerError: asShortString(rawMateDiagnostics.provider_error),
          candidateSelectionSource:
            typeof rawMateDiagnostics.candidate_selection_source === 'string' &&
            ['model', 'view_votes', 'none'].includes(rawMateDiagnostics.candidate_selection_source)
              ? (rawMateDiagnostics.candidate_selection_source as 'model' | 'view_votes' | 'none')
              : undefined,
          selectedMatchesConsensus:
            typeof rawMateDiagnostics.selected_matches_consensus === 'boolean'
              ? rawMateDiagnostics.selected_matches_consensus
              : undefined,
          flags: Array.isArray(rawMateDiagnostics.flags)
            ? rawMateDiagnostics.flags.filter((item): item is string => typeof item === 'string').slice(0, 12)
            : [],
        }
      : undefined;
    const voteTally = new Map<string, { key: string; weight: number; votes: number }>();
    const voteCandidateByKey = new Map<string, (typeof candidateRows)[number]>();
    for (const vote of parsedViewVotes) {
      let matchedCandidate =
        candidateRows.find((candidate: (typeof candidateRows)[number]) => {
          if (vote.candidateIndex !== undefined && candidate.candidateIndex === vote.candidateIndex) return true;
          if (vote.candidateKey && candidate.candidateKey === vote.candidateKey) return true;
          return false;
        }) || null;
      if (!matchedCandidate && vote.candidateKey) {
        matchedCandidate =
          candidateRowsBySemantic.find((candidate: (typeof candidateRowsBySemantic)[number]) => candidate.candidateKey === vote.candidateKey) || null;
      }
      const key = matchedCandidate?.candidateKey || vote.candidateKey;
      if (!key) continue;
      const prev = voteTally.get(key) || { key, weight: 0, votes: 0 };
      prev.weight += vote.weight;
      prev.votes += 1;
      voteTally.set(key, prev);
      if (matchedCandidate) voteCandidateByKey.set(key, matchedCandidate);
    }
    const voteTallySorted = [...voteTally.values()].sort((a, b) => b.weight - a.weight);
    const viewVoteWeightTotal = voteTallySorted.reduce((sum, item) => sum + item.weight, 0);
    const consensusTop = voteTallySorted[0];
    const viewConsensus =
      consensusTop && viewVoteWeightTotal > 1e-6 ? Math.max(0, Math.min(1, consensusTop.weight / viewVoteWeightTotal)) : undefined;
    const viewAgreement =
      consensusTop && parsedViewVotes.length > 0 ? Math.max(0, Math.min(1, consensusTop.votes / parsedViewVotes.length)) : undefined;
    const consensusCandidate =
      consensusTop ? voteCandidateByKey.get(consensusTop.key) || candidateRowsBySemantic.find((candidate) => candidate.candidateKey === consensusTop.key) || null : null;

    const selectedCandidateIndex =
      Number.isInteger(Number(rawMate?.selected_candidate_index))
        ? Number(rawMate.selected_candidate_index)
        : Number.isInteger(Number(rawMate?.candidate_index))
        ? Number(rawMate.candidate_index)
        : undefined;
    const selectedCandidateKey = asShortString(rawMate?.selected_candidate_key ?? rawMate?.candidate_key);
    const selectedCandidate =
      candidateRows.find((candidate: (typeof candidateRows)[number]) => {
        if (selectedCandidateIndex !== undefined && candidate.candidateIndex === selectedCandidateIndex) return true;
        if (selectedCandidateKey && candidate.candidateKey === selectedCandidateKey) return true;
        return false;
      }) || null;
    const vlmAbstain = rawMate?.abstain === true;
    const vlmCandidate = rawMate
      ? {
          selectedCandidateIndex,
          selectedCandidateKey,
          sourcePartRef: asShortString(rawMate.source_part_ref),
          targetPartRef: asShortString(rawMate.target_part_ref),
          sourceFace: asFace(rawMate.source_face) ?? selectedCandidate?.sourceFace,
          targetFace: asFace(rawMate.target_face) ?? selectedCandidate?.targetFace,
          sourceMethod: asMethod(rawMate.source_method) ?? selectedCandidate?.sourceMethod,
          targetMethod: asMethod(rawMate.target_method) ?? selectedCandidate?.targetMethod,
          mode: asMode(rawMate.mode),
          intent: asIntent(rawMate.intent),
          confidence: vlmConfidence,
          reason: asShortString(rawMate.reason),
          actionDescription: asShortString(rawMate.action_description),
        }
      : undefined;

    const topPairs = ranking
      .slice(0, 6)
      .map((row: any) => `${String(row?.sourceFace || '')}:${String(row?.targetFace || '')}`);
    const vlmFacePair = vlmCandidate?.sourceFace && vlmCandidate?.targetFace
      ? `${vlmCandidate.sourceFace}:${vlmCandidate.targetFace}`
      : null;
    const vlmFaceSupported = !vlmFacePair || topPairs.includes(vlmFacePair);
    // Derive effective confidence from view vote consensus/agreement rather than raw model
    // confidence. Local VLM models (e.g. ollama/qwen) often output a fixed confidence
    // (~0.74) regardless of actual certainty. View consensus — how much views AGREE on
    // the same candidate — is a more reliable signal than the raw number.
    let effectiveVlmConfidence: number | undefined;
    if (viewConsensus !== undefined && viewAgreement !== undefined) {
      effectiveVlmConfidence = viewConsensus * 0.65 + viewAgreement * 0.35;
    } else if (viewConsensus !== undefined) {
      effectiveVlmConfidence = viewConsensus;
    } else {
      effectiveVlmConfidence = vlmCandidate?.confidence;
    }
    const useVlm = Boolean(vlmCandidate && !vlmAbstain && (effectiveVlmConfidence ?? 0) >= 0.62);

    const faceThreshold = vlmFaceSupported ? 0.62 : 0.84;
    const methodThreshold = 0.7;
    const intentThreshold = 0.62;

    let finalIntent =
      preferredMode && geometryIntent !== 'default'
        ? geometryIntent
        : useVlm && (effectiveVlmConfidence ?? 0) >= intentThreshold && vlmCandidate?.intent
        ? vlmCandidate.intent
        : geometryIntent;
    // Mode is determined by geometry + rotation mismatch ONLY — VLM is excluded from
    // mode decisions because local models tend to conservatively pick 'both' for simple
    // flat cover/translate mates.  Geometry analysis is more reliable here:
    //   insert intent  → 'both'   (rotation correction likely needed)
    //   cover/default  → 'translate' (pure stacking, no rotation)
    //   rotation mismatch detected → 'both' (forced by quaternion analysis)
    let finalMode = preferredMode || (hasRotationMismatch ? 'both' : geometryMode);
    let finalSourceFace =
      preferredSourceFace ||
      (useVlm && (effectiveVlmConfidence ?? 0) >= faceThreshold && vlmCandidate?.sourceFace
        ? vlmCandidate.sourceFace
        : geometrySourceFace);
    let finalTargetFace =
      preferredTargetFace ||
      (useVlm && (effectiveVlmConfidence ?? 0) >= faceThreshold && vlmCandidate?.targetFace
        ? vlmCandidate.targetFace
        : geometryTargetFace);
    let finalSourceMethod =
      explicitSourceMethod ||
      (useVlm && (effectiveVlmConfidence ?? 0) >= methodThreshold && vlmCandidate?.sourceMethod
        ? vlmCandidate.sourceMethod
        : geometrySourceMethod);
    let finalTargetMethod =
      explicitTargetMethod ||
      (useVlm && (effectiveVlmConfidence ?? 0) >= methodThreshold && vlmCandidate?.targetMethod
        ? vlmCandidate.targetMethod
        : geometryTargetMethod);

    const arbitration: string[] = [];
    const coverLike = finalIntent === 'cover' || geometryIntent === 'cover';
    const insertLike = finalIntent === 'insert' || geometryIntent === 'insert';
    let finalAxis = facePairAxis(finalSourceFace, finalTargetFace);
    if (!useVlm && insertLike && !explicitTargetMethod && finalTargetMethod === 'object_aabb') {
      const insertMethodCandidate = candidateRowsBySemantic.find((candidate) => candidate.tags.includes('insert_friendly'));
      if (insertMethodCandidate) {
        finalSourceMethod = insertMethodCandidate.sourceMethod;
        finalTargetMethod = insertMethodCandidate.targetMethod;
        arbitration.push('insert_target_method_guard');
      }
    }
    if (viewConsensus !== undefined && viewConsensus >= 0.58) {
      arbitration.push('vlm_view_consensus_applied');
    } else if (viewConsensus !== undefined && viewConsensus < 0.5) {
      arbitration.push('vlm_view_consensus_low');
    }
    if (useVlm && consensusCandidate && selectedCandidate && consensusCandidate.candidateKey !== selectedCandidate.candidateKey) {
      if ((viewConsensus ?? 0) >= 0.66) {
        finalSourceFace = consensusCandidate.sourceFace;
        finalTargetFace = consensusCandidate.targetFace;
        if (!explicitSourceMethod) finalSourceMethod = consensusCandidate.sourceMethod;
        if (!explicitTargetMethod) finalTargetMethod = consensusCandidate.targetMethod;
        arbitration.push('vlm_consensus_candidate_override');
      }
    }
    const centerExpectedAxis = facePairAxis(geometrySourceFace, geometryTargetFace);
    const preferredInsertVerticalCandidate =
      insertLike && ySeparated && !preferredSourceFace && !preferredTargetFace
        ? candidateRowsBySemantic.find((candidate) => {
            if (!candidate.tags.includes('insert_friendly')) return false;
            if (!candidate.tags.includes('vertical_pair')) return false;
            if (sourceAboveTarget) return candidate.tags.includes('bottom_to_top');
            if (sourceBelowTarget) return candidate.tags.includes('top_to_bottom');
            return true;
          }) ||
          candidateRowsBySemantic.find(
            (candidate) => candidate.tags.includes('insert_friendly') && candidate.tags.includes('vertical_pair')
          )
        : null;
    finalAxis = facePairAxis(finalSourceFace, finalTargetFace);
    if (
      insertLike &&
      ySeparated &&
      !preferredSourceFace &&
      !preferredTargetFace &&
      preferredInsertVerticalCandidate &&
      finalAxis !== 'y'
    ) {
      finalSourceFace = preferredInsertVerticalCandidate.sourceFace;
      finalTargetFace = preferredInsertVerticalCandidate.targetFace;
      if (!explicitSourceMethod) finalSourceMethod = preferredInsertVerticalCandidate.sourceMethod;
      if (!explicitTargetMethod) finalTargetMethod = preferredInsertVerticalCandidate.targetMethod;
      arbitration.push('insert_vertical_face_override');
      finalAxis = facePairAxis(finalSourceFace, finalTargetFace);
    }
    if (insertLike && !preferredSourceFace && !preferredTargetFace && centerExpectedAxis !== 'y' && finalAxis === 'y') {
      arbitration.push('insert_center_drift_guard');
    }
    if (coverLike && !preferredSourceFace && !preferredTargetFace && centerExpectedAxis !== 'y' && finalAxis === 'y') {
      arbitration.push('cover_center_drift_guard');
    }
    if (useVlm && !vlmFaceSupported) arbitration.push('vlm_face_not_in_geometry_top6');
    finalSourceMethod = normalizeAnchorMethod(finalSourceMethod, 'planar_cluster');
    finalTargetMethod = normalizeAnchorMethod(finalTargetMethod, 'planar_cluster');

    const origin: 'geometry' | 'vlm' | 'hybrid' =
      !useVlm ? 'geometry' : vlmFaceSupported ? 'hybrid' : 'hybrid';

    const notes: string[] = [
      `geometry.intent=${geometryIntent}`,
      `geometry.mode=${geometryMode}`,
      `capture.views=${capture.images.length}`,
    ];
    if (vlmCandidate?.confidence !== undefined) notes.push(`vlm.confidence=${vlmCandidate.confidence.toFixed(2)}`);
    if (effectiveVlmConfidence !== undefined) notes.push(`vlm.conf.effective=${effectiveVlmConfidence.toFixed(2)}`);
    if (viewConsensus !== undefined) notes.push(`vlm.viewConsensus=${viewConsensus.toFixed(2)}`);
    if (viewAgreement !== undefined) notes.push(`vlm.viewAgreement=${viewAgreement.toFixed(2)}`);
    if (vlmError) notes.push(`vlm.error=${vlmError}`);
    if (hasRotationMismatch) notes.push(`rotation_mismatch=${rotationMismatchDeg.toFixed(1)}deg`);
    if (useVlm && !vlmFaceSupported) notes.push('vlm.face_pair_not_in_geometry_top6');
    if (selectedCandidate) notes.push(`vlm.candidate=${selectedCandidate.candidateKey}`);
    if (arbitration.length) notes.push(`arbitration=${arbitration.join('|')}`);

    return ok(
      {
        source,
        target,
        geometry: {
          intent: geometryIntent,
          suggestedMode: geometryMode,
          hasRotationMismatch,
          rotationMismatchDeg: Number(rotationMismatchDeg.toFixed(2)),
          expectedFromCenters: {
            sourceFace: geometrySourceFace,
            targetFace: geometryTargetFace,
          },
          rankingTop: rankingTop
            ? {
                sourceFace: rankingTop.sourceFace,
                targetFace: rankingTop.targetFace,
                sourceMethod: rankingTop.sourceMethod,
                targetMethod: rankingTop.targetMethod,
                score: Number(rankingTop.score ?? 0),
              }
            : null,
        },
        capture: {
          imageCount: capture.images.length,
          views: capture.images.map((img) => ({
            name: img.name,
            label: img.label,
            widthPx: img.widthPx,
            heightPx: img.heightPx,
          })),
        },
        vlm: {
          used: Boolean(vlmResult && !vlmError),
          ...(parsedVlmDiagnostics?.provider ? { provider: parsedVlmDiagnostics.provider } : {}),
          ...(vlmCandidate
            ? {
                confidence: vlmCandidate.confidence,
                ...(effectiveVlmConfidence !== undefined ? { viewConsensus } : {}),
                ...(effectiveVlmConfidence !== undefined ? { viewAgreement } : {}),
                ...(parsedViewVotes.length ? { voteCount: parsedViewVotes.length } : {}),
                ...(consensusTop?.key ? { consensusCandidateKey: consensusTop.key } : {}),
                ...(parsedVlmDiagnostics
                  ? {
                      diagnostics: {
                        ...(parsedVlmDiagnostics.provider ? { provider: parsedVlmDiagnostics.provider } : {}),
                        ...(parsedVlmDiagnostics.repairAttempts !== undefined
                          ? { repairAttempts: parsedVlmDiagnostics.repairAttempts }
                          : {}),
                        ...(parsedVlmDiagnostics.fallbackUsed !== undefined
                          ? { fallbackUsed: parsedVlmDiagnostics.fallbackUsed }
                          : {}),
                        ...(parsedVlmDiagnostics.providerError ? { providerError: parsedVlmDiagnostics.providerError } : {}),
                        ...(parsedVlmDiagnostics.candidateSelectionSource
                          ? { candidateSelectionSource: parsedVlmDiagnostics.candidateSelectionSource }
                          : {}),
                        ...(parsedVlmDiagnostics.selectedMatchesConsensus !== undefined
                          ? { selectedMatchesConsensus: parsedVlmDiagnostics.selectedMatchesConsensus }
                          : {}),
                        flags: parsedVlmDiagnostics.flags,
                      },
                    }
                  : {}),
                ...(parsedViewVotes.length
                  ? {
                      viewVotes: parsedViewVotes.slice(0, 8).map((vote) => ({
                        viewName: vote.viewName,
                        ...(vote.candidateKey ? { candidateKey: vote.candidateKey } : {}),
                        ...(vote.confidence !== undefined ? { confidence: vote.confidence } : {}),
                        weight: Number(vote.weight.toFixed(3)),
                      })),
                    }
                  : {}),
                mateInference: {
                  ...vlmCandidate,
                  ...(vlmCandidate.selectedCandidateIndex !== undefined
                    ? { selectedCandidateIndex: vlmCandidate.selectedCandidateIndex }
                    : {}),
                },
              }
            : {}),
          ...(!vlmCandidate && parsedVlmDiagnostics
            ? {
                diagnostics: {
                  ...(parsedVlmDiagnostics.provider ? { provider: parsedVlmDiagnostics.provider } : {}),
                  ...(parsedVlmDiagnostics.repairAttempts !== undefined
                    ? { repairAttempts: parsedVlmDiagnostics.repairAttempts }
                    : {}),
                  ...(parsedVlmDiagnostics.fallbackUsed !== undefined
                    ? { fallbackUsed: parsedVlmDiagnostics.fallbackUsed }
                    : {}),
                  ...(parsedVlmDiagnostics.providerError ? { providerError: parsedVlmDiagnostics.providerError } : {}),
                  ...(parsedVlmDiagnostics.candidateSelectionSource
                    ? { candidateSelectionSource: parsedVlmDiagnostics.candidateSelectionSource }
                    : {}),
                  ...(parsedVlmDiagnostics.selectedMatchesConsensus !== undefined
                    ? { selectedMatchesConsensus: parsedVlmDiagnostics.selectedMatchesConsensus }
                    : {}),
                  flags: parsedVlmDiagnostics.flags,
                },
              }
            : {}),
          ...(vlmError ? { fallbackReason: vlmError } : {}),
        },
        inferred: {
          sourcePartId: source.partId,
          targetPartId: target.partId,
          sourceFace: finalSourceFace,
          targetFace: finalTargetFace,
          sourceMethod: finalSourceMethod,
          targetMethod: finalTargetMethod,
          mode: finalMode,
          intent: finalIntent,
          confidence: Math.max(0.55, Math.min(0.98, useVlm ? (effectiveVlmConfidence ?? 0.62) : 0.58)),
          origin,
          arbitration,
          ...((vlmCandidate?.reason || arbitration.length)
            ? { reason: [vlmCandidate?.reason, arbitration.join('|')].filter(Boolean).join(' ; ').slice(0, 180) }
            : {}),
          ...(vlmCandidate?.actionDescription
            ? { actionDescription: vlmCandidate.actionDescription }
            : {}),
        },
        notes,
      },
      { mutating: false }
    );
  }

  if (tool === 'view.set_environment') {
    const next = String((args as any).environment || '').toLowerCase();
    if (!ENVIRONMENT_PRESETS.includes(next as any)) {
      throw new ToolExecutionError({
        code: 'INVALID_ARGUMENT',
        message: `Unknown environment '${next}'`,
        detail: { allowed: ENVIRONMENT_PRESETS },
        suggestedToolCalls: [{ tool: 'ui.get_sync_state', args: {} }],
      });
    }

    const store = currentStore();
    const changed = store.view.environment !== next;
    store.setEnvironment(next);
    return ok({ view: viewSnapshot() }, { mutating: changed });
  }

  if (tool === 'view.set_grid_visible') {
    const visible = Boolean((args as any).visible);
    const store = currentStore();
    const changed = store.view.showGrid !== visible;
    store.setGridVisible(visible);
    return ok({ view: viewSnapshot() }, { mutating: changed });
  }

  if (tool === 'view.set_anchors_visible') {
    const visible = Boolean((args as any).visible);
    const store = currentStore();
    const changed = store.view.showAnchors !== visible;
    store.setAnchorsVisible(visible);
    return ok({ view: viewSnapshot() }, { mutating: changed });
  }

  if (tool === 'view.capture_image') {
    const input = args as any;
    const format = String(input.format || 'png').toLowerCase();
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const jpegQuality = Number(input.jpegQuality ?? 0.92);

    const { renderer, scene, camera, viewportPx } = getRendererOrThrow();
    const maxWidthPx = clampInt(input.maxWidthPx ?? 1024, 64, 2048);
    const maxHeightPx = clampInt(input.maxHeightPx ?? 768, 64, 2048);
    const size = computeCaptureSize({
      viewportWidth: viewportPx.width,
      viewportHeight: viewportPx.height,
      maxWidthPx,
      maxHeightPx,
    });

    const prevTarget = renderer.getRenderTarget();
    const prevAspect =
      (camera as any).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).aspect : null;

    const renderTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
      depthBuffer: true,
      stencilBuffer: false,
    });
    const pixels = new Uint8Array(size.width * size.height * 4);

    try {
      if ((camera as any).isPerspectiveCamera) {
        const pcam = camera as THREE.PerspectiveCamera;
        pcam.aspect = size.width / Math.max(1, size.height);
        pcam.updateProjectionMatrix();
      }
      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, size.width, size.height, pixels);
    } catch (error: any) {
      throw new ToolExecutionError({
        code: 'UNSUPPORTED_OPERATION',
        message: `View capture failed: ${error?.message || 'unknown'}`,
        recoverable: true,
      });
    } finally {
      renderer.setRenderTarget(prevTarget);
      if (prevAspect !== null && (camera as any).isPerspectiveCamera) {
        const pcam = camera as THREE.PerspectiveCamera;
        pcam.aspect = prevAspect;
        pcam.updateProjectionMatrix();
      }
      renderTarget.dispose();
    }

    let dataUrl = '';
    try {
      dataUrl = dataUrlFromPixels({
        pixels,
        width: size.width,
        height: size.height,
        mimeType,
        jpegQuality,
      });
    } catch (error: any) {
      throw new ToolExecutionError({
        code: 'UNSUPPORTED_OPERATION',
        message: `View capture encode failed: ${error?.message || 'unknown'}`,
        recoverable: true,
      });
    }

    return ok(
      {
        image: {
          dataUrl,
          mimeType,
          widthPx: size.width,
          heightPx: size.height,
        },
      },
      { mutating: false }
    );
  }

  if (tool === 'parts.set_cad_url') {
    const url = String((args as any).url || '');
    const fileName = String((args as any).fileName || 'CAD');
    if (!url) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'url is required' });
    }

    const store = currentStore();
    const changed = store.cadUrl !== url || store.cadFileName !== fileName;
    store.setCadUrl(url, fileName);
    resetRuntimeForNewScene();
    return ok({ url, fileName, changed }, { mutating: changed });
  }

  if (tool === 'mode.set_interaction_mode') {
    const mode = (args as any).mode as InteractionMode;
    const changed = mode !== runtimeState.interactionMode;
    runtimeState.interactionMode = mode;
    currentStore().setInteractionMode(mode);
    return ok({ mode, changed }, { mutating: changed });
  }

  if (tool === 'ui.get_sync_state') {
    const store = currentStore();
    return ok(
      {
        state: {
          sceneRevision: runtimeState.sceneRevision,
          interactionMode: runtimeState.interactionMode,
          selection: runtimeState.selection,
          preview: previewFromRuntimeOrNull(),
          playback: {
            running: store.playback.running,
            currentStepId: store.steps.currentStepId,
          },
          history: {
            canUndo: store.history.past.length > 0,
            canRedo: store.history.future.length > 0,
            size: store.history.past.length,
          },
        },
      },
      { mutating: false }
    );
  }

  if (tool === 'action.set_part_transform') {
    const part = resolvePart((args as any).part);
    const input = (args as any).transform as { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number]; space?: string };
    const space = String(input?.space || 'world');
    if (space !== 'world') {
      throw new ToolExecutionError({
        code: 'UNSUPPORTED_OPERATION',
        message: `Only world-space transforms are supported (got '${space}')`,
        suggestedToolCalls: [{ tool: 'query.part_transform', args: { part: { partId: part.partId }, space: 'world' } }],
      });
    }

    const nextQ = quat4(input.quaternion).normalize();
    const nextTransform: PartTransform = {
      position: input.position,
      quaternion: [nextQ.x, nextQ.y, nextQ.z, nextQ.w],
      scale: input.scale,
    };

    const previewOnly = Boolean((args as any).previewOnly);
    if (previewOnly) {
      const current = getPartTransformOrThrow(part.partId);
      const previewId = crypto.randomUUID();
      const planId = `set-transform-${previewId}`;
      ensurePreviewBeforeTransform(part.partId);
      currentStore().setPartOverrideSilent(part.partId, nextTransform);
      runtimeState.preview = { previewId, planId, active: true, scrubT: 1, partId: part.partId };
      runtimeState.plans.set(planId, {
        planId,
        operation: 'align',
        source: { kind: 'part', part },
        pathType: 'line',
        durationMs: 200,
        steps: [
          { index: 0, timeMs: 0, positionWorld: current.position, quaternionWorld: current.quaternion },
          { index: 1, timeMs: 200, positionWorld: nextTransform.position, quaternionWorld: nextTransform.quaternion },
        ],
      });
      return ok(
        {
          part,
          transform: { ...nextTransform, space: 'world' as const },
          previewId,
        },
        { mutating: true }
      );
    }

    currentStore().setPartOverride(part.partId, nextTransform);
    clearPreviewState(part.partId);
    return ok(
      {
        part,
        transform: { ...nextTransform, space: 'world' as const },
      },
      { mutating: true }
    );
  }

  if (tool === 'action.reset_part') {
    const part = resolvePart((args as any).part);
    const store = currentStore();
    const hadOverride = Boolean(store.parts.overridesById[part.partId]);
    store.clearPartOverride(part.partId);
    // Also remove the part from any assembly group
    store.removePartFromGroup(part.partId);
    clearPreviewState(part.partId);
    const transform = store.getPartTransform(part.partId);
    return ok(
      {
        part,
        reset: hadOverride,
        transform: transform ? { ...transform, space: 'world' as const } : undefined,
      },
      { mutating: hadOverride }
    );
  }

  if (tool === 'action.reset_all') {
    const store = currentStore();
    const resetCount = Object.keys(store.parts.overridesById || {}).length;
    const groupCount = Object.keys(store.assemblyGroups?.byId || {}).length;
    store.clearAllPartOverrides();
    // Also dissolve all assembly groups so parts return to independent state
    if (groupCount > 0) {
      store.dispatch('reset_all_groups', () => ({
        assemblyGroups: { byId: {}, order: [] },
      }));
    }
    clearPreviewState();
    runtimeState.previewBeforeTransformByPartId.clear();
    return ok({ resetCount, groupsCleared: groupCount }, { mutating: resetCount > 0 || groupCount > 0 });
  }

  if (tool === 'action.reset_part_transform') {
    const input = args as any;
    const part = resolvePart(input.part);
    const mode = String(input.mode || 'initial') as 'initial' | 'manual';
    const store = currentStore();
    if (mode === 'manual') {
      const manualTransform = store.parts.manualTransformById[part.partId];
      if (!manualTransform) {
        return ok(
          { part, reset: false, mode, reason: 'no_manual_transform_recorded' },
          { mutating: false }
        );
      }
      store.resetPartToManual(part.partId);
      const transform = store.getPartTransform(part.partId);
      return ok(
        { part, reset: true, mode, transform: transform ? { ...transform, space: 'world' as const } : undefined },
        { mutating: true }
      );
    } else {
      const hadOverride = Boolean(store.parts.overridesById[part.partId]);
      store.resetPartToInitial(part.partId);
      clearPreviewState(part.partId);
      const transform = store.getPartTransform(part.partId);
      return ok(
        { part, reset: hadOverride, mode, transform: transform ? { ...transform, space: 'world' as const } : undefined },
        { mutating: hadOverride }
      );
    }
  }

  if (tool === 'action.translate') {
    const part = resolvePart((args as any).part);
    const transform = getPartTransformOrThrow(part.partId);
    const currentPos = vec3(transform.position);
    const toPosition = (args as any).toPosition as [number, number, number] | undefined;
    const delta = (args as any).delta as [number, number, number] | undefined;

    const nextPos = toPosition ? vec3(toPosition) : currentPos.clone().add(delta ? vec3(delta) : new THREE.Vector3(0, 0, 0));
    const nextTransform: PartTransform = {
      position: tuple3(nextPos),
      quaternion: transform.quaternion,
      scale: transform.scale,
    };

    const previewOnly = Boolean((args as any).previewOnly);
    if (previewOnly) {
      const previewId = crypto.randomUUID();
      const planId = `translate-${previewId}`;
      ensurePreviewBeforeTransform(part.partId);
      currentStore().setPartOverrideSilent(part.partId, nextTransform);
      runtimeState.preview = { previewId, planId, active: true, scrubT: 1, partId: part.partId };
      runtimeState.plans.set(planId, {
        planId,
        operation: 'translate',
        source: { kind: 'part', part },
        pathType: 'line',
        durationMs: 200,
        steps: [
          { index: 0, timeMs: 0, positionWorld: transform.position, quaternionWorld: transform.quaternion },
          { index: 1, timeMs: 200, positionWorld: nextTransform.position, quaternionWorld: nextTransform.quaternion },
        ],
      });
      return ok(
        {
          part,
          transform: { ...nextTransform, space: 'world' as const },
          previewId,
        },
        { mutating: true }
      );
    }

    currentStore().setPartOverride(part.partId, nextTransform);
    // Keep manualTransformById in sync so baseManualTransforms is correct when adding steps later
    currentStore().setManualTransform(part.partId, nextTransform);
    clearPreviewState(part.partId);
    return ok(
      {
        part,
        transform: { ...nextTransform, space: 'world' as const },
      },
      { mutating: true }
    );
  }

  if (tool === 'action.rotate') {
    const part = resolvePart((args as any).part);
    const transform = getPartTransformOrThrow(part.partId);
    const axisArgs = (args as any).axis;
    const axis = resolveTwistAxis({
      axis: axisArgs.axis,
      axisSpace: axisArgs.axisSpace,
    });
    const angleDeg = Number((args as any).angleDeg || 0);
    const pivot = (args as any).pivotWorld ? vec3((args as any).pivotWorld) : vec3(transform.position);

    const qDelta = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(angleDeg));
    const startPos = vec3(transform.position);
    const nextPos = pivot.clone().add(startPos.clone().sub(pivot).applyQuaternion(qDelta));
    const nextQuat = qDelta.clone().multiply(quat4(transform.quaternion)).normalize();

    const nextTransform: PartTransform = {
      position: tuple3(nextPos),
      quaternion: tuple4(nextQuat),
      scale: transform.scale,
    };

    const previewOnly = Boolean((args as any).previewOnly);
    if (previewOnly) {
      const previewId = crypto.randomUUID();
      const planId = `rotate-${previewId}`;
      ensurePreviewBeforeTransform(part.partId);
      currentStore().setPartOverrideSilent(part.partId, nextTransform);
      runtimeState.preview = { previewId, planId, active: true, scrubT: 1, partId: part.partId };
      runtimeState.plans.set(planId, {
        planId,
        operation: 'rotate',
        source: { kind: 'part', part },
        pathType: 'line',
        durationMs: 200,
        steps: [
          { index: 0, timeMs: 0, positionWorld: transform.position, quaternionWorld: transform.quaternion },
          { index: 1, timeMs: 200, positionWorld: nextTransform.position, quaternionWorld: nextTransform.quaternion },
        ],
      });
      return ok(
        {
          part,
          transform: { ...nextTransform, space: 'world' as const },
          appliedAngleDeg: angleDeg,
          previewId,
        },
        { mutating: true }
      );
    }

    currentStore().setPartOverride(part.partId, nextTransform);
    currentStore().setManualTransform(part.partId, nextTransform);
    clearPreviewState(part.partId);
    return ok(
      {
        part,
        transform: { ...nextTransform, space: 'world' as const },
        appliedAngleDeg: angleDeg,
      },
      {
        mutating: true,
        debug: {
          rotationAxisWorld: tuple3(axis),
          rotationAngleDeg: angleDeg,
        },
      }
    );
  }

  if (tool === 'action.generate_transform_plan') {
    const input = args as any;
    const source = resolveFeature(input.source);
    const target = input.target ? resolveFeature(input.target) : undefined;

    if (source.kind !== 'part' && source.kind !== 'face') {
      throw new ToolExecutionError({
        code: 'INVALID_ARGUMENT',
        message: 'source must be part or face for current implementation',
      });
    }

    const sourcePartId = source.part.partId;
    const sourceTransform = getPartTransformOrThrow(sourcePartId);

    const operation = input.operation as 'translate' | 'rotate' | 'align' | 'mate' | 'twist' | 'both';

    let endTransform: PartTransform = {
      position: [...sourceTransform.position],
      quaternion: [...sourceTransform.quaternion],
      scale: [...sourceTransform.scale],
    };

    let pathType: 'line' | 'arc' | 'screw' | 'none' = 'line';
    const debugNotes: string[] = [];

    if (operation === 'twist' && !target) {
      const twistInput = input.twist ?? { angleDeg: 0, axis: 'normal', axisSpace: 'world' };
      const axis = resolveTwistAxis({
        axis: twistInput.axis,
        axisSpace: twistInput.axisSpace,
      });
      const angleDeg = Number(twistInput.angleDeg || 0);
      const qTwist = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(angleDeg));
      const nextQuat = qTwist.multiply(quat4(sourceTransform.quaternion)).normalize();
      endTransform = {
        position: sourceTransform.position,
        quaternion: tuple4(nextQuat),
        scale: sourceTransform.scale,
      };
      pathType = 'line';
    } else if (target) {
      const sourceFrame = featureFrame(source);
      const targetFrame = featureFrame(target);

      if (operation === 'mate') {
        const sourceObj = getV2ObjectByPartId(sourcePartId);
        const targetObj = getV2ObjectByPartId(target.part.partId);
        const sourceFaceId = source.kind === 'face' && STORE_FACES.includes(source.face as any) ? (source.face as StoreFaceId) : null;
        const targetFaceId = target.kind === 'face' && STORE_FACES.includes(target.face as any) ? (target.face as StoreFaceId) : null;
        const sourceMethod = source.kind === 'face'
          ? normalizeAnchorMethod(source.methodRequested ?? source.methodUsed, 'planar_cluster')
          : 'planar_cluster';
        const targetMethod = target.kind === 'face'
          ? normalizeAnchorMethod(target.methodRequested ?? target.methodUsed, 'planar_cluster')
          : 'planar_cluster';
        const sourceOffset = parseOffsetTuple(input.sourceOffset);
        const targetOffset = parseOffsetTuple(input.targetOffset);

        if (sourceObj && targetObj && sourceFaceId && targetFaceId) {
          // Sync positions from store to avoid stale React async state
          const curStore = currentStore();
          const srcT =
            curStore.parts.overridesById[sourcePartId] || curStore.parts.initialTransformById[sourcePartId];
          if (srcT) {
            sourceObj.position.set(srcT.position[0], srcT.position[1], srcT.position[2]);
            sourceObj.quaternion.set(srcT.quaternion[0], srcT.quaternion[1], srcT.quaternion[2], srcT.quaternion[3]);
          }
          const tgtPartId = target.part.partId;
          const tgtT =
            curStore.parts.overridesById[tgtPartId] || curStore.parts.initialTransformById[tgtPartId];
          if (tgtT) {
            targetObj.position.set(tgtT.position[0], tgtT.position[1], tgtT.position[2]);
            targetObj.quaternion.set(tgtT.quaternion[0], tgtT.quaternion[1], tgtT.quaternion[2], tgtT.quaternion[3]);
          }
          sourceObj.updateWorldMatrix(true, false);
          targetObj.updateWorldMatrix(true, false);

          const solvedTranslate = solveMateTopBottom(
            sourceObj,
            targetObj,
            sourceFaceId,
            targetFaceId,
            'translate',
            undefined,
            sourceMethod,
            targetMethod,
            undefined,
            undefined,
            sourceOffset,
            targetOffset
          );

          if (solvedTranslate) {
            const sourceWorldPos = new THREE.Vector3();
            sourceObj.getWorldPosition(sourceWorldPos);
            const nextWorldPos = sourceWorldPos.clone().add(solvedTranslate.translation);

            const nextLocalPos = sourceObj.parent
              ? nextWorldPos.clone().applyMatrix4(new THREE.Matrix4().copy(sourceObj.parent.matrixWorld).invert())
              : nextWorldPos;

            endTransform = {
              position: tuple3(nextLocalPos),
              quaternion: [...sourceTransform.quaternion],
              scale: [...sourceTransform.scale],
            };

            pathType = input.pathPreference === 'arc' ? 'arc' : input.pathPreference === 'screw' ? 'screw' : 'line';
            debugNotes.push('Mate translate solved by shared solver path');

            const durationMs = Number(input.durationMs ?? 900);
            const sampleCount = Number(input.sampleCount ?? 60);
            const steps = samplePath({
              start: sourceTransform,
              end: endTransform,
              durationMs,
              sampleCount,
              pathType: pathType === 'screw' ? 'line' : pathType,
              arcHeight: Number(input.arc?.height ?? 0),
              arcLiftAxis: targetFrame.bitangent,
            });

            const planId = crypto.randomUUID();
            const plan = {
              planId,
              operation,
              mode: input.mateMode,
              source,
              ...(target ? { target } : {}),
              pathType,
              durationMs,
              steps,
              constraints: {
                offset: Number(input.offset ?? 0),
                clearance: Number(input.clearance ?? 0),
                flip: Boolean(input.flip),
                twistAngleDeg: 0,
                limitAxes: [],
                enforceCollisionCheck: false,
              },
              autoFixes: [],
              debug: {
                sourceFrame,
                targetFrame,
                sourceFaceId,
                targetFaceId,
                sourceMethod,
                targetMethod,
                sourceOffset,
                targetOffset,
                sourceFaceCenterWorld: tuple3(solvedTranslate.sourceFaceCenter),
                targetFaceCenterWorld: tuple3(solvedTranslate.targetFaceCenter),
                translationWorld: tuple3(solvedTranslate.translation),
                translationLocal: tuple3(vec3(endTransform.position).sub(vec3(sourceTransform.position))),
                pathType,
                notes: debugNotes,
              },
            };

            runtimeState.plans.set(planId, plan);
            return ok({ plan }, { mutating: true, debug: plan.debug });
          }
        }

        debugNotes.push('Mate translate fallback: shared solver unavailable, using frame delta');
        const targetNormal = normalize(vec3(targetFrame.normal), new THREE.Vector3(0, 1, 0));
        const targetPoint = vec3(targetFrame.origin).clone().add(targetNormal.clone().multiplyScalar(Number(input.offset ?? 0) + Number(input.clearance ?? 0)));
        const delta = targetPoint.clone().sub(vec3(sourceFrame.origin));
        endTransform = {
          position: tuple3(vec3(sourceTransform.position).add(delta)),
          quaternion: [...sourceTransform.quaternion],
          scale: [...sourceTransform.scale],
        };
        pathType = input.pathPreference === 'arc' ? 'arc' : input.pathPreference === 'screw' ? 'screw' : 'line';

        const durationMs = Number(input.durationMs ?? 900);
        const sampleCount = Number(input.sampleCount ?? 60);
        const steps = samplePath({
          start: sourceTransform,
          end: endTransform,
          durationMs,
          sampleCount,
          pathType: pathType === 'screw' ? 'line' : pathType,
          arcHeight: Number(input.arc?.height ?? 0),
          arcLiftAxis: targetFrame.bitangent,
        });

        const planId = crypto.randomUUID();
        const plan = {
          planId,
          operation,
          mode: input.mateMode,
          source,
          ...(target ? { target } : {}),
          pathType,
          durationMs,
          steps,
          constraints: {
            offset: Number(input.offset ?? 0),
            clearance: Number(input.clearance ?? 0),
            flip: Boolean(input.flip),
            twistAngleDeg: 0,
            limitAxes: [],
            enforceCollisionCheck: false,
          },
          autoFixes: [],
          debug: {
            sourceFrame,
            targetFrame,
            sourceFaceId,
            targetFaceId,
            sourceMethod,
            targetMethod,
            sourceOffset,
            targetOffset,
            translationWorld: tuple3(delta),
            translationLocal: tuple3(vec3(endTransform.position).sub(vec3(sourceTransform.position))),
            pathType,
            notes: debugNotes,
          },
        };

        runtimeState.plans.set(planId, plan);
        return ok({ plan }, { mutating: true, debug: plan.debug });
      }

      const twistInput = input.twist ?? { angleDeg: 0, axis: 'normal', axisSpace: 'target_face' };
      const applyTwist = operation === 'both' || operation === 'twist' || Math.abs(Number(twistInput.angleDeg || 0)) > 1e-6;

      const sourceObj = getV2ObjectByPartId(sourcePartId);
      const targetObj = target ? getV2ObjectByPartId(target.part.partId) : null;

      // Sync positions from store to avoid stale React async state
      if (sourceObj && targetObj) {
        const curStore = currentStore();
        const srcT = curStore.parts.overridesById[sourcePartId] || curStore.parts.initialTransformById[sourcePartId];
        if (srcT) {
          sourceObj.position.set(srcT.position[0], srcT.position[1], srcT.position[2]);
          sourceObj.quaternion.set(srcT.quaternion[0], srcT.quaternion[1], srcT.quaternion[2], srcT.quaternion[3]);
        }
        const tgtPartId = target!.part.partId;
        const tgtT = curStore.parts.overridesById[tgtPartId] || curStore.parts.initialTransformById[tgtPartId];
        if (tgtT) {
          targetObj.position.set(tgtT.position[0], tgtT.position[1], tgtT.position[2]);
          targetObj.quaternion.set(tgtT.quaternion[0], tgtT.quaternion[1], tgtT.quaternion[2], tgtT.quaternion[3]);
        }
        sourceObj.updateWorldMatrix(true, false);
        targetObj.updateWorldMatrix(true, false);
      } else if (sourceObj) {
        sourceObj.updateWorldMatrix(true, false);
      }

      const sourceWorldPos = sourceObj ? sourceObj.getWorldPosition(new THREE.Vector3()) : null;
      const sourceWorldQuat = sourceObj ? sourceObj.getWorldQuaternion(new THREE.Quaternion()) : null;

      const sourceWorldTransform: PartTransform =
        sourceObj && sourceWorldPos && sourceWorldQuat
          ? {
              position: tuple3(sourceWorldPos),
              quaternion: tuple4(sourceWorldQuat),
              scale: [...sourceTransform.scale],
            }
          : sourceTransform;

      // Build TwistSpec: undefined = auto tangent alignment via computeTwistFromTangents
      // explicit angleDeg > 0 = manual override
      const twistAngleDeg = Math.abs(Number(twistInput.angleDeg || 0));
      const twistSpec = twistAngleDeg > 1e-6
        ? {
            angleDeg: Number(twistInput.angleDeg),
            axis: (twistInput.axis || 'normal') as 'x' | 'y' | 'z' | 'normal' | 'tangent' | 'bitangent',
            axisSpace: (twistInput.axisSpace || 'target_face') as 'world' | 'source_face' | 'target_face',
          }
        : undefined;

      // Try robust solveMateTopBottom path first (uses setFromUnitVectors + computeTwistFromTangents)
      const sourceFaceId = source.kind === 'face' && STORE_FACES.includes(source.face as any) ? (source.face as StoreFaceId) : null;
      const targetFaceId = target && target.kind === 'face' && STORE_FACES.includes(target.face as any) ? (target.face as StoreFaceId) : null;
      const sourceMethod = source.kind === 'face'
        ? normalizeAnchorMethod(source.methodRequested ?? source.methodUsed, 'planar_cluster')
        : 'planar_cluster';
      const targetMethod = target && target.kind === 'face'
        ? normalizeAnchorMethod(target.methodRequested ?? target.methodUsed, 'planar_cluster')
        : 'planar_cluster';
      const sourceOffsetTuple = parseOffsetTuple(input.sourceOffset);
      const targetOffsetTuple = parseOffsetTuple(input.targetOffset);
      const solverMode = operation === 'twist' ? 'twist' : 'both';

      let endWorldTransform: PartTransform | null = null;
      let endTransformPrecomputed = false;

      if (sourceObj && targetObj && sourceFaceId && targetFaceId && sourceWorldPos && sourceWorldQuat) {
        const solvedBoth = solveMateTopBottom(
          sourceObj, targetObj,
          sourceFaceId, targetFaceId,
          solverMode, twistSpec,
          sourceMethod, targetMethod,
          undefined, undefined,
          sourceOffsetTuple, targetOffsetTuple
        );
        if (solvedBoth) {
          // Simulate applyMateTransform exactly as MateExecutor does, then read back local state
          const savedPos = sourceObj.position.clone();
          const savedQuat = sourceObj.quaternion.clone();

          applyMateTransform(sourceObj, solvedBoth);
          sourceObj.updateMatrixWorld(true);

          const newWorldPosAnim = sourceObj.getWorldPosition(new THREE.Vector3());
          const newWorldQuatAnim = sourceObj.getWorldQuaternion(new THREE.Quaternion());

          endWorldTransform = {
            position: operation === 'twist' ? [...sourceWorldTransform.position] : tuple3(newWorldPosAnim),
            quaternion: tuple4(newWorldQuatAnim),
            scale: [...sourceTransform.scale],
          };
          endTransform = {
            position: operation === 'twist' ? [...sourceTransform.position] : tuple3(sourceObj.position),
            quaternion: tuple4(sourceObj.quaternion),
            scale: [...sourceTransform.scale],
          };
          endTransformPrecomputed = true;

          // Restore
          sourceObj.position.copy(savedPos);
          sourceObj.quaternion.copy(savedQuat);
          sourceObj.updateMatrixWorld(true);

          debugNotes.push('Alignment solved by solveMateTopBottom (applyMateTransform simulation, mode=' + solverMode + ')');
        }
      }

      if (!endWorldTransform) {
        // Fallback: frame-based solver
        const solved = computeMateAlignedEndTransform({
          sourceTransform: sourceWorldTransform,
          sourceFrame,
          targetFrame,
          offset: Number(input.offset ?? 0),
          clearance: Number(input.clearance ?? 0),
          flip: Boolean(input.flip),
          applyTwist,
          twistAngleDeg: Number(twistInput.angleDeg || 0),
          twistAxis: twistInput.axis,
          twistAxisSpace: twistInput.axisSpace,
        });
        endWorldTransform = {
          position: operation === 'twist' ? [...sourceWorldTransform.position] : [...solved.endTransform.position],
          quaternion: [...solved.endTransform.quaternion],
          scale: [...sourceTransform.scale],
        };
        debugNotes.push('Alignment solved from source/target feature frames (fallback)');
      }

      pathType =
        input.pathPreference === 'arc' ||
        input.pathPreference === 'screw' ||
        (input.pathPreference === 'auto' && (operation === 'both' || input.mateMode === 'face_insert_arc'))
          ? input.pathPreference === 'screw'
            ? 'screw'
            : 'arc'
          : 'line';

      if (operation === 'twist') debugNotes.push('Twist mode keeps part position fixed');

      const durationMs = Number(input.durationMs ?? 900);
      const sampleCount = Number(input.sampleCount ?? 60);
      const arcHeight = Number(input.arc?.height ?? 0);
      const resolvedEndWorldTransform = endWorldTransform!;
      const stepsWorld = samplePath({
        start: sourceWorldTransform,
        end: resolvedEndWorldTransform,
        durationMs,
        sampleCount,
        pathType: pathType === 'screw' ? 'line' : pathType,
        arcHeight,
        arcLiftAxis: targetFrame.bitangent,
      });
      const steps =
        sourceObj && sourceWorldPos && sourceWorldQuat
          ? stepsWorld.map((step) => {
              const local = worldPoseToLocalPose(
                sourceObj,
                vec3(step.positionWorld),
                quat4(step.quaternionWorld).normalize()
              );
              return {
                ...step,
                positionWorld: local.position,
                quaternionWorld: local.quaternion,
              };
            })
          : stepsWorld;

      // Keep endTransform consistent with store-local space for downstream tooling/debug.
      if (!endTransformPrecomputed) {
        endTransform =
          sourceObj && sourceWorldPos && sourceWorldQuat
            ? {
                ...sourceTransform,
                ...worldPoseToLocalPose(sourceObj, vec3(resolvedEndWorldTransform.position), quat4(resolvedEndWorldTransform.quaternion).normalize()),
              }
            : resolvedEndWorldTransform;
      }

      const planId = crypto.randomUUID();
      const plan = {
        planId,
        operation,
        mode: input.mateMode,
        source,
        ...(target ? { target } : {}),
        pathType,
        durationMs,
        steps,
        constraints: {
          offset: Number(input.offset ?? 0),
          clearance: Number(input.clearance ?? 0),
          flip: Boolean(input.flip),
          twistAngleDeg: Number(twistInput.angleDeg ?? 0),
          limitAxes: [],
          enforceCollisionCheck: false,
        },
        autoFixes: [],
        debug: {
          sourceFrame,
          targetFrame,
          translationWorld: tuple3(vec3(resolvedEndWorldTransform.position).sub(vec3(sourceWorldTransform.position))),
          pathType,
          notes: debugNotes,
        },
      };

      runtimeState.plans.set(planId, plan);
      return ok({ plan }, { mutating: true, debug: plan.debug });
    } else {
      debugNotes.push('No target specified; plan keeps current transform');
    }

    const durationMs = Number(input.durationMs ?? 900);
    const sampleCount = Number(input.sampleCount ?? 60);
    const steps = samplePath({
      start: sourceTransform,
      end: endTransform,
      durationMs,
      sampleCount,
      pathType: 'line',
      arcHeight: Number(input.arc?.height ?? 0),
    });

    const planId = crypto.randomUUID();
    const plan = {
      planId,
      operation,
      mode: input.mateMode,
      source,
      ...(target ? { target } : {}),
      pathType,
      durationMs,
      steps,
      constraints: {
        offset: Number(input.offset ?? 0),
        clearance: Number(input.clearance ?? 0),
        flip: Boolean(input.flip),
        twistAngleDeg: Number(input.twist?.angleDeg ?? 0),
        limitAxes: [],
        enforceCollisionCheck: false,
      },
      autoFixes: [],
      debug: {
        notes: debugNotes,
      },
    };

    runtimeState.plans.set(planId, plan);
    return ok({ plan }, { mutating: true, debug: plan.debug });
  }

  if (tool === 'action.mate_execute') {
    const input = args as any;
    const source = resolvePart(input.sourcePart);
    const target = resolvePart(input.targetPart);

    const mode = (input.mode ?? 'translate') as 'translate' | 'twist' | 'both';
    const operation = mode === 'both' ? 'both' : mode === 'twist' ? 'twist' : 'mate';
    const mateMode = input.mateMode ?? (mode === 'both' ? 'face_insert_arc' : 'face_flush');
    const pathPreference =
      input.pathPreference ?? (mode === 'both' ? 'arc' : mode === 'twist' ? 'line' : 'line');

    const twist =
      input.twist ??
      (mode === 'twist'
        ? {
            angleDeg: 45,
            axis: 'normal',
            axisSpace: 'target_face',
            constraint: 'free',
          }
        : {
            angleDeg: 0,
            axis: 'normal',
            axisSpace: 'target_face',
            constraint: 'free',
          });

    // When a sourceGroupId is provided, compute a sourceOffset that shifts the
    // anchor from part1-only to the combined AABB of the whole group.
    let computedSourceOffset: [number, number, number] | undefined = input.sourceOffset;
    if (input.sourceGroupId) {
      const grpStore = currentStore();
      const allMemberIds = grpStore.getGroupParts(input.sourceGroupId as string);
      const sceneRef = getV2Scene();
      if (sceneRef && allMemberIds.length > 1) {
        const sourceObjRef = sceneRef.getObjectByProperty('uuid', source.partId) ?? null;
        if (sourceObjRef) {
          sourceObjRef.updateWorldMatrix(true, true);
          const combinedBox = new THREE.Box3();
          for (const mId of allMemberIds) {
            const mObj = sceneRef.getObjectByProperty('uuid', mId);
            if (mObj) {
              mObj.updateWorldMatrix(true, true);
              const mBox = computeWorldPercentileBox(mObj);
              if (!mBox.isEmpty()) combinedBox.union(mBox);
            }
          }
          const part1Box = computeWorldPercentileBox(sourceObjRef);
          if (!combinedBox.isEmpty() && !part1Box.isEmpty()) {
            const faceId: string = input.sourceFace ?? 'bottom';
            const getAabbFaceCenter = (box: THREE.Box3, fId: string): THREE.Vector3 => {
              const c = box.getCenter(new THREE.Vector3());
              switch (fId) {
                case 'top':    return new THREE.Vector3(c.x, box.max.y, c.z);
                case 'bottom': return new THREE.Vector3(c.x, box.min.y, c.z);
                case 'left':   return new THREE.Vector3(box.min.x, c.y, c.z);
                case 'right':  return new THREE.Vector3(box.max.x, c.y, c.z);
                case 'front':  return new THREE.Vector3(c.x, c.y, box.max.z);
                case 'back':   return new THREE.Vector3(c.x, c.y, box.min.z);
                default:       return c;
              }
            };
            const part1AnchorWorld = getAabbFaceCenter(part1Box, faceId);
            const groupAnchorWorld = getAabbFaceCenter(combinedBox, faceId);
            const worldDelta = groupAnchorWorld.clone().sub(part1AnchorWorld);
            if (worldDelta.lengthSq() > 1e-10) {
              const mat3 = new THREE.Matrix3().setFromMatrix4(sourceObjRef.matrixWorld);
              const localDelta = worldDelta.clone().applyMatrix3(mat3.clone().invert());
              const existing = input.sourceOffset ? new THREE.Vector3(...(input.sourceOffset as [number,number,number])) : new THREE.Vector3();
              const final = existing.add(localDelta);
              computedSourceOffset = [final.x, final.y, final.z];
            }
          }
        }
      }
    }

    // When a targetGroupId is provided, compute a targetOffset that shifts the anchor
    // from the representative part to the LARGEST group member's AABB face.
    // Using the largest member (rather than combined AABB) avoids the "floating part"
    // problem: when group members are at different Y positions (e.g., part1 floating
    // above base before assembly), combined AABB.maxY = part1.maxY which is wrong.
    // The largest member is typically the chassis/base whose exterior face is the true
    // mating surface.
    let computedTargetOffset: [number, number, number] | undefined = input.targetOffset;
    if (input.targetGroupId) {
      const grpStore = currentStore();
      const allMemberIds = grpStore.getGroupParts(input.targetGroupId as string);
      const sceneRef = getV2Scene();
      if (sceneRef && allMemberIds.length > 1) {
        const targetObjRef = sceneRef.getObjectByProperty('uuid', target.partId) ?? null;
        if (targetObjRef) {
          targetObjRef.updateWorldMatrix(true, true);

          // Find the largest member by bbox volume (most likely the chassis/base body)
          let largestMemberBox: THREE.Box3 | null = null;
          let largestVolume = -1;
          for (const mId of allMemberIds) {
            const mObj = sceneRef.getObjectByProperty('uuid', mId);
            if (mObj) {
              mObj.updateWorldMatrix(true, true);
              const mBox = computeWorldPercentileBox(mObj);
              if (!mBox.isEmpty()) {
                const sz = mBox.getSize(new THREE.Vector3());
                const vol = sz.x * sz.y * sz.z;
                if (vol > largestVolume) { largestVolume = vol; largestMemberBox = mBox; }
              }
            }
          }

          const repBox = computeWorldPercentileBox(targetObjRef);
          if (largestMemberBox && !repBox.isEmpty()) {
            const tgtFaceId: string = input.targetFace ?? 'top';
            const getAabbFaceCenterTgt = (box: THREE.Box3, fId: string): THREE.Vector3 => {
              const c = box.getCenter(new THREE.Vector3());
              switch (fId) {
                case 'top':    return new THREE.Vector3(c.x, box.max.y, c.z);
                case 'bottom': return new THREE.Vector3(c.x, box.min.y, c.z);
                case 'left':   return new THREE.Vector3(box.min.x, c.y, c.z);
                case 'right':  return new THREE.Vector3(box.max.x, c.y, c.z);
                case 'front':  return new THREE.Vector3(c.x, c.y, box.max.z);
                case 'back':   return new THREE.Vector3(c.x, c.y, box.min.z);
                default:       return c;
              }
            };
            const repAnchorWorld = getAabbFaceCenterTgt(repBox, tgtFaceId);
            const largestAnchorWorld = getAabbFaceCenterTgt(largestMemberBox, tgtFaceId);
            const worldDelta = largestAnchorWorld.clone().sub(repAnchorWorld);
            if (worldDelta.lengthSq() > 1e-10) {
              const mat3 = new THREE.Matrix3().setFromMatrix4(targetObjRef.matrixWorld);
              const localDelta = worldDelta.clone().applyMatrix3(mat3.clone().invert());
              const existing = computedTargetOffset ? new THREE.Vector3(...computedTargetOffset) : new THREE.Vector3();
              const final = existing.add(localDelta);
              computedTargetOffset = [final.x, final.y, final.z];
            }
          }
        }
      }
    }

    // Capture source pre-preview transform NOW (before generate_transform_plan moves it)
    // so group delta propagation at commit time gets the correct "before" position.
    if (input.sourceGroupId) {
      ensurePreviewBeforeTransform(source.partId);
    }

    const generated = await runTool('action.generate_transform_plan' as MCPToolName, {
      operation,
      source: {
        kind: 'face',
        part: { partId: source.partId },
        face: input.sourceFace ?? 'bottom',
        method: normalizeAnchorMethod(input.sourceMethod, 'planar_cluster'),
      },
      target: {
        kind: 'face',
        part: { partId: target.partId },
        face: input.targetFace ?? 'top',
        method: normalizeAnchorMethod(input.targetMethod, 'planar_cluster'),
      },
      sourceOffset: computedSourceOffset,
      targetOffset: computedTargetOffset,
      mateMode,
      pathPreference,
      durationMs: input.durationMs ?? 900,
      sampleCount: input.sampleCount ?? 60,
      flip: Boolean(input.flip),
      offset: Number(input.offset ?? 0),
      clearance: Number(input.clearance ?? (mode === 'both' ? 0.01 : 0)),
      twist,
      arc: input.arc ?? { height: mode === 'both' ? 0.08 : 0, lateralBias: 0 },
      autoCorrectSelection: input.autoCorrectSelection !== false,
      autoSwapSourceTarget: input.autoSwapSourceTarget !== false,
      enforceNormalPolicy: input.enforceNormalPolicy ?? 'source_out_target_in',
    } as any);
    const generatedData = unwrapToolData(generated, 'SOLVER_FAILED');
    const plan = generatedData.plan;

    const previewed = await runTool('preview.transform_plan' as MCPToolName, {
      planId: plan.planId,
      replaceCurrent: true,
      scrubT: 1,
    } as any);
    const previewData = unwrapToolData(previewed, 'PREVIEW_NOT_FOUND');
    const preview = previewData.preview;

    if (input.commit === false) {
      return ok(
        {
          source,
          target,
          plan,
          preview,
          committed: false,
        },
        { mutating: false, debug: plan.debug }
      );
    }

    // Capture before-mate transform of source part (for group delta propagation)
    const sourceBeforeTransform = runtimeState.previewBeforeTransformByPartId.get(source.partId)
      ?? getPartTransformOrThrow(source.partId);

    const committed = await runTool('action.commit_preview' as MCPToolName, {
      previewId: preview.previewId,
      pushHistory: input.pushHistory !== false,
      stepLabel:
        input.stepLabel ?? `Mate ${source.partName} to ${target.partName}`,
    } as any);
    const commitData = unwrapToolData(committed, 'PREVIEW_NOT_FOUND');

    // Propagate rigid body delta to other group members if sourceGroupId specified
    const groupDiagnostics: string[] = [];
    if (input.sourceGroupId) {
      const store = currentStore();
      const afterTransform = getPartTransformOrThrow(source.partId);
      const beforePos = new THREE.Vector3(...sourceBeforeTransform.position);
      const afterPos = new THREE.Vector3(...afterTransform.position);
      const beforeQuat = new THREE.Quaternion(...sourceBeforeTransform.quaternion);
      const afterQuat = new THREE.Quaternion(...afterTransform.quaternion);
      const rotDelta = afterQuat.clone().multiply(beforeQuat.clone().invert());
      const posDelta = afterPos.clone().sub(beforePos);

      const memberIds = store.getGroupParts(input.sourceGroupId).filter((id: string) => id !== source.partId);
      groupDiagnostics.push(`group=${input.sourceGroupId} members=${memberIds.length} posDelta=[${posDelta.toArray().map(n=>n.toFixed(3)).join(',')}]`);

      for (const memberId of memberIds) {
        // Read member's current world position directly from Three.js (more reliable
        // than the store for parts that haven't been re-committed since their last move).
        const memberObj = getV2ObjectByPartId(memberId);
        if (!memberObj) {
          groupDiagnostics.push(`  ${memberId}: object not found in scene — skipped`);
          continue;
        }
        memberObj.updateWorldMatrix(true, false);
        const memberPos = new THREE.Vector3();
        const memberQuat = new THREE.Quaternion();
        memberObj.getWorldPosition(memberPos);
        memberObj.getWorldQuaternion(memberQuat);

        // Rigid body delta: rotate the relative position around the pre-mate source pos,
        // then translate to the post-mate source pos.
        const relPos = memberPos.clone().sub(beforePos);
        relPos.applyQuaternion(rotDelta);
        const newPos = afterPos.clone().add(relPos);
        const newQuat = rotDelta.clone().multiply(memberQuat);

        const memberScale = (store.getPartTransform(memberId) ?? getPartTransformOrThrow(memberId)).scale;

        // Apply to Three.js object immediately (drives the visual)
        memberObj.position.set(newPos.x, newPos.y, newPos.z);
        memberObj.quaternion.set(newQuat.x, newQuat.y, newQuat.z, newQuat.w);
        memberObj.updateMatrixWorld(true);

        // Persist to Zustand store so snapshots / step playback use the correct position
        store.setPartOverride(memberId, {
          position: [newPos.x, newPos.y, newPos.z],
          quaternion: [newQuat.x, newQuat.y, newQuat.z, newQuat.w],
          scale: memberScale,
        });
        store.setManualTransform(memberId, {
          position: [newPos.x, newPos.y, newPos.z],
          quaternion: [newQuat.x, newQuat.y, newQuat.z, newQuat.w],
          scale: memberScale,
        });
        groupDiagnostics.push(`  ${memberId}: moved to [${newPos.toArray().map(n=>n.toFixed(3)).join(',')}]`);
      }
    }

    // Auto-group source and target after successful mate
    {
      const store = currentStore();
      const srcGroupId = store.getGroupForPart(source.partId);
      const tgtGroupId = store.getGroupForPart(target.partId);
      if (srcGroupId && tgtGroupId && srcGroupId !== tgtGroupId) {
        store.mergeAssemblyGroups(srcGroupId, tgtGroupId);
      } else if (srcGroupId) {
        store.addPartToGroup(srcGroupId, target.partId);
      } else if (tgtGroupId) {
        store.addPartToGroup(tgtGroupId, source.partId);
      } else {
        store.createAssemblyGroup([source.partId, target.partId]);
      }
    }

    return ok(
      {
        source,
        target,
        plan,
        preview,
        committed: true,
        historyId: commitData.historyId,
        transform: commitData.transform,
        ...(groupDiagnostics.length > 0 ? { groupRigidBody: groupDiagnostics } : {}),
      },
      { mutating: false, debug: plan.debug }
    );
  }

  if (tool === 'action.smart_mate_execute') {
    const input = args as any;
    const source = resolvePart(input.sourcePart);
    const target = resolvePart(input.targetPart);
    const instruction = normalizeInstructionText(input.instruction);
    const instructionMethod = methodFromInstruction(instruction);

    const explicitSourceFace =
      STORE_FACES.includes(input.sourceFace as StoreFaceId) ? (input.sourceFace as StoreFaceId) : undefined;
    const explicitTargetFace =
      STORE_FACES.includes(input.targetFace as StoreFaceId) ? (input.targetFace as StoreFaceId) : undefined;
    const explicitSourceMethod = parseExplicitAnchorMethod(input.sourceMethod) ?? undefined;
    const explicitTargetMethod = parseExplicitAnchorMethod(input.targetMethod) ?? undefined;
    const explicitMode =
      typeof input.mode === 'string' && ['translate', 'twist', 'both'].includes(input.mode)
        ? (input.mode as MateExecMode)
        : undefined;

    let inferred: any = null;
    let inferOrigin: string | null = null;
    let inferConfidence: number | null = null;
    try {
      const inferredEnvelope = await runTool('query.mate_vlm_infer' as MCPToolName, {
        sourcePart: { partId: source.partId },
        targetPart: { partId: target.partId },
        instruction,
        ...(explicitSourceFace ? { preferredSourceFace: explicitSourceFace } : {}),
        ...(explicitTargetFace ? { preferredTargetFace: explicitTargetFace } : {}),
        sourceMethod: explicitSourceMethod ?? 'planar_cluster',
        targetMethod: explicitTargetMethod ?? 'planar_cluster',
        ...(explicitMode ? { preferredMode: explicitMode } : {}),
        maxPairs: 12,
        maxViews: 6,
        maxWidthPx: 640,
        maxHeightPx: 480,
        format: 'jpeg',
      } as any);
      const inferredData = unwrapToolData(inferredEnvelope, 'SOLVER_FAILED') as any;
      inferred = inferredData?.inferred ?? null;
      inferOrigin = typeof inferred?.origin === 'string' ? inferred.origin : null;
      inferConfidence = typeof inferred?.confidence === 'number' ? inferred.confidence : null;
      if (typeof inferred?.actionDescription === 'string') {
        (inferred as any).actionDescription = inferred.actionDescription;
      }
    } catch {
      inferred = null;
    }

    const sourceObject = getV2ObjectByPartId(source.partId);
    const targetObject = getV2ObjectByPartId(target.partId);

    // Build geometry hint for LLM.
    let geometryHint: Record<string, unknown> | undefined;
    const fallbackPair = getExpectedFacePairFromCenters(
      vec3(getPartTransformOrThrow(source.partId).position),
      vec3(getPartTransformOrThrow(target.partId).position)
    );
    if (sourceObject && targetObject) {
      const srcBox = worldBoundingBoxFromObject(sourceObject);
      const tgtBox = worldBoundingBoxFromObject(targetObject);
      const srcCtr = vec3(srcBox.center);
      const tgtCtr = vec3(tgtBox.center);
      geometryHint = {
        expectedFacePair: getExpectedFacePairFromCenters(srcCtr, tgtCtr),
        sourceBboxSize: srcBox.size,
        targetBboxSize: tgtBox.size,
        relativePosition: { dx: tgtCtr.x - srcCtr.x, dy: tgtCtr.y - srcCtr.y, dz: tgtCtr.z - srcCtr.z },
      };
    }

    // Ask LLM for semantic decisions (intent, mode, face, method).
    const agentParams = await callAgentForMateParams({
      userText: instruction,
      sourcePart: { id: source.partId, name: source.partName },
      targetPart: { id: target.partId, name: target.partName },
      geometryHint,
    });

    // LLM primary; geometry fallback when LLM unavailable.
    const geometryFallbackIntent = agentParams === null && sourceObject && targetObject
      ? inferIntentFromGeometryFallback(sourceObject, targetObject)
      : null;
    const intentKind: MateIntentKind =
      agentParams?.intent ?? geometryFallbackIntent ?? 'default';
    const mode: MateExecMode =
      explicitMode ??
      (typeof inferred?.mode === 'string' && ['translate', 'twist', 'both'].includes(inferred.mode)
        ? (inferred.mode as MateExecMode)
        : agentParams?.mode ?? (intentKind === 'cover' ? 'both' : 'translate'));
    const operation = mode === 'both' ? 'both' : mode === 'twist' ? 'twist' : 'mate';
    const mateMode = input.mateMode ?? (mode === 'both' ? 'face_insert_arc' : 'face_flush');
    const pathPreferenceRaw = (input.pathPreference as 'auto' | 'line' | 'arc' | 'screw' | undefined) ?? 'auto';
    const pathPreference =
      pathPreferenceRaw === 'auto' ? (mode === 'both' ? 'arc' : 'line') : pathPreferenceRaw;

    // LLM-recommended methods (fall back to intent-based priority if unavailable).
    const llmSourceMethod = agentParams?.sourceMethod ?? null;
    const llmTargetMethod = agentParams?.targetMethod ?? null;
    const sourceMethodPriority = buildMethodPriority({
      explicit: explicitSourceMethod ?? (instructionMethod ?? llmSourceMethod),
      instructionMethod: null,
      intent: intentKind,
      role: 'source',
    });
    const targetMethodPriority = buildMethodPriority({
      explicit: explicitTargetMethod ?? (instructionMethod ?? llmTargetMethod),
      instructionMethod: null,
      intent: intentKind,
      role: 'target',
    });

    // LLM-recommended faces seed the geometry-based face pair search.
    const llmSourceFace = agentParams?.sourceFace ?? null;
    const llmTargetFace = agentParams?.targetFace ?? null;

    const suggestedFacePair =
      sourceObject && targetObject
        ? inferBestFacePair({
            sourceObject,
            targetObject,
            sourceMethods: sourceMethodPriority,
            targetMethods: targetMethodPriority,
            preferredSourceFace: explicitSourceFace ?? llmSourceFace,
            preferredTargetFace: explicitTargetFace ?? llmTargetFace,
          })
        : null;

    const chosenSourceFace =
      explicitSourceFace ??
      (inferred?.sourceFace as StoreFaceId | undefined) ??
      suggestedFacePair?.sourceFace ??
      llmSourceFace ??
      fallbackPair.sourceFace;
    const chosenTargetFace =
      explicitTargetFace ??
      (inferred?.targetFace as StoreFaceId | undefined) ??
      suggestedFacePair?.targetFace ??
      llmTargetFace ??
      fallbackPair.targetFace;
    const chosenSourceMethod =
      explicitSourceMethod ??
      normalizeAnchorMethod(inferred?.sourceMethod as AnchorMethodId | undefined, 'planar_cluster') ??
      suggestedFacePair?.sourceMethod ??
      sourceMethodPriority[0] ??
      'planar_cluster';
    const chosenTargetMethod =
      explicitTargetMethod ??
      normalizeAnchorMethod(inferred?.targetMethod as AnchorMethodId | undefined, 'planar_cluster') ??
      suggestedFacePair?.targetMethod ??
      targetMethodPriority[0] ??
      'planar_cluster';

    const fallbackClearance = mode === 'both' ? 0.01 : 0;
    const requestedClearance = Number(input.clearance ?? 0);
    const clearance = requestedClearance > 0 ? requestedClearance : fallbackClearance;

    const twist =
      input.twist ??
      (mode === 'twist'
        ? {
            angleDeg: 45,
            axis: 'normal',
            axisSpace: 'target_face',
            constraint: 'free',
          }
        : {
            angleDeg: 0,
            axis: 'normal',
            axisSpace: 'target_face',
            constraint: 'free',
          });

    const executed = await runTool('action.mate_execute' as MCPToolName, {
      sourcePart: { partId: source.partId },
      targetPart: { partId: target.partId },
      ...(input.sourceGroupId ? { sourceGroupId: input.sourceGroupId } : {}),
      ...(input.targetGroupId ? { targetGroupId: input.targetGroupId } : {}),
      sourceFace: chosenSourceFace,
      targetFace: chosenTargetFace,
      sourceMethod: chosenSourceMethod,
      targetMethod: chosenTargetMethod,
      sourceOffset: input.sourceOffset,
      targetOffset: input.targetOffset,
      mode,
      mateMode,
      pathPreference,
      durationMs: input.durationMs ?? 900,
      sampleCount: input.sampleCount ?? 60,
      flip: Boolean(input.flip),
      offset: Number(input.offset ?? 0),
      clearance,
      twist,
      arc: input.arc ?? { height: mode === 'both' ? 0.08 : 0, lateralBias: 0 },
      autoCorrectSelection: true,
      autoSwapSourceTarget: true,
      enforceNormalPolicy: input.enforceNormalPolicy ?? 'source_out_target_in',
      commit: input.commit !== false,
      pushHistory: input.pushHistory !== false,
      stepLabel: input.stepLabel ?? `Mate ${source.partName} to ${target.partName}`,
    } as any);
    const executedData = unwrapToolData(executed, 'SOLVER_FAILED');

    return ok(
      {
        source,
        target,
        chosen: {
          sourceFace: chosenSourceFace,
          targetFace: chosenTargetFace,
          sourceMethod: chosenSourceMethod,
          targetMethod: chosenTargetMethod,
          mode,
          mateMode,
          pathPreference,
        },
        ...(typeof inferred?.actionDescription === 'string' ? { actionDescription: inferred.actionDescription } : {}),
        plan: executedData.plan,
        preview: executedData.preview,
        committed: executedData.committed,
        ...(executedData.historyId ? { historyId: executedData.historyId } : {}),
        ...(executedData.transform ? { transform: executedData.transform } : {}),
      },
      {
        mutating: false,
        debug: {
          notes: [
            'Smart mate executed with LLM + geometry-aware inference (fallback-safe).',
            `intent=${intentKind}`,
            `infer_origin=${inferOrigin ?? 'none'}`,
            `infer_confidence=${inferConfidence !== null ? inferConfidence.toFixed(2) : 'n/a'}`,
            `llm_confidence=${agentParams?.confidence ?? 'n/a'}`,
            `instruction_method=${instructionMethod ?? 'none'}`,
          ],
          llmReasoning: agentParams?.reasoning,
          sourceFaceId: chosenSourceFace,
          targetFaceId: chosenTargetFace,
          sourceMethod: chosenSourceMethod,
          targetMethod: chosenTargetMethod,
          mode,
          pathType: pathPreference,
          explicit: {
            sourceFace: explicitSourceFace ?? null,
            targetFace: explicitTargetFace ?? null,
            sourceMethod: explicitSourceMethod ?? null,
            targetMethod: explicitTargetMethod ?? null,
            mode: explicitMode ?? null,
          },
        } as any,
      }
    );
  }

  // ── action.demo_mate_and_apply ───────────────────────────────────────────────
  // One-command demo path: mate + commit + auto-create step.
  // Eliminates the need for separate "add step" and "run" commands in demos.
  if ((tool as string) === 'action.demo_mate_and_apply') {
    const input = args as any;
    const autoStep = input.autoStep !== false;  // default true
    const label = String(input.stepLabel || '').trim()
      || `Mate ${(input.sourcePart?.partName ?? input.sourcePart?.partId ?? 'part')} → ${(input.targetPart?.partName ?? input.targetPart?.partId ?? 'part')}`;

    // Step 1: run smart_mate_execute
    const mateEnvelope = await runTool('action.smart_mate_execute' as MCPToolName, {
      sourcePart: input.sourcePart,
      targetPart: input.targetPart,
      instruction: input.instruction ?? '',
      ...(input.sourceGroupId ? { sourceGroupId: input.sourceGroupId } : {}),
      ...(input.sourceFace ? { sourceFace: input.sourceFace } : {}),
      ...(input.targetFace ? { targetFace: input.targetFace } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      durationMs: input.durationMs ?? 800,
      commit: true,
    } as any);
    const mateData = unwrapToolData(mateEnvelope, 'SOLVER_FAILED') as any;

    // Step 2: auto-add a step capturing the current scene state
    let stepResult: any = null;
    if (autoStep) {
      const stepEnvelope = await runTool('steps.add' as MCPToolName, { label, select: true } as any);
      stepResult = unwrapToolData(stepEnvelope, 'INTERNAL_ERROR') as any;
    }

    return ok(
      {
        source: mateData.source,
        target: mateData.target,
        committed: mateData.committed,
        chosen: mateData.chosen,
        ...(mateData.transform ? { transform: mateData.transform } : {}),
        ...(autoStep && stepResult ? { step: stepResult.step } : {}),
        autoStepCreated: autoStep,
      },
      {
        mutating: true,
        debug: { notes: [`demo_mate_and_apply: mate committed, step auto-created=${autoStep}`] },
      }
    );
  }

  if (tool === 'preview.transform_plan') {
    const input = args as any;
    const plan = input.plan ?? runtimeState.plans.get(input.planId);
    if (!plan) {
      throw new ToolExecutionError({ code: 'PREVIEW_NOT_FOUND', message: 'Plan not found for preview' });
    }

    runtimeState.plans.set(plan.planId, plan);

    const partId = plan.source?.part?.partId;
    if (!partId) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'Plan source part not found' });
    }

    ensurePreviewBeforeTransform(partId);

    const scrubT = typeof input.scrubT === 'number' ? input.scrubT : 1;
    const previewTransform = interpolateTransform(plan.steps, scrubT);
    currentStore().setPartOverrideSilent(partId, {
      position: previewTransform.position,
      quaternion: previewTransform.quaternion,
      scale: getPartTransformOrThrow(partId).scale,
    });

    const activePreview = runtimeState.preview;
    const previewId =
      activePreview && activePreview.partId === partId && activePreview.planId === plan.planId
        ? activePreview.previewId
        : crypto.randomUUID();

    runtimeState.preview = {
      previewId,
      planId: plan.planId,
      active: true,
      scrubT,
      partId,
    };

    return ok(
      {
        preview: {
          previewId,
          planId: plan.planId,
          active: true,
          scrubT,
        },
      },
      { mutating: true }
    );
  }

  if (tool === 'preview.status') {
    return ok(
      {
        preview: previewFromRuntimeOrNull(),
      },
      { mutating: false }
    );
  }

  if (tool === 'preview.cancel') {
    const input = args as any;
    if (!runtimeState.preview) {
      return ok(
        {
          canceled: false,
          preview: null,
        },
        { mutating: false }
      );
    }

    if (input.previewId && runtimeState.preview.previewId !== input.previewId) {
      throw new ToolExecutionError({ code: 'PREVIEW_NOT_FOUND', message: 'previewId does not match active preview' });
    }

    restorePreviewTransformIfNeeded(runtimeState.preview.partId);
    clearPreviewState();
    return ok(
      {
        canceled: true,
        preview: null,
      },
      { mutating: true }
    );
  }

  if (tool === 'action.commit_preview') {
    const input = args as any;
    if (!runtimeState.preview || runtimeState.preview.previewId !== input.previewId) {
      throw new ToolExecutionError({ code: 'PREVIEW_NOT_FOUND', message: 'No active preview for commit' });
    }

    const partId = runtimeState.preview.partId;
    const current = getPartTransformOrThrow(partId);
    currentStore().setPartOverride(partId, current);

    // For non-mate operations (translate/rotate/align previews), the committed position
    // is a user-intentional placement → update manualTransformById so that steps added
    // later use this as the correct start position, not the original import position.
    // Mate commits (operation='mate'|'both'|'twist') must NOT update manualTransformById
    // because the before-mate position (captured in previewBeforeTransformByPartId) is
    // what the step's start should be.
    const committedPlan = runtimeState.plans.get(runtimeState.preview.planId);
    const isMoveOp = committedPlan &&
      !['mate', 'both', 'twist'].includes(committedPlan.operation as string);
    if (isMoveOp) {
      currentStore().setManualTransform(partId, current);
    }

    runtimeState.previewBeforeTransformByPartId.delete(partId);

    const historyId = `history-${crypto.randomUUID()}`;
    clearPreviewState();
    return ok(
      {
        committed: true,
        previewId: input.previewId,
        historyId,
        transform: {
          position: current.position,
          quaternion: current.quaternion,
          scale: current.scale,
          space: 'world',
        },
      },
      { mutating: true }
    );
  }

  if (tool === 'steps.add') {
    const label = String((args as any).label || '').trim();
    if (!label) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'label is required' });
    }
    const select = (args as any).select !== false;

    const store = currentStore();
    store.addStep(label);
    const list = currentStore().steps.list;
    const step = list[list.length - 1];
    if (!step) {
      throw new ToolExecutionError({ code: 'INTERNAL_ERROR', message: 'Failed to create step' });
    }
    if (select) currentStore().selectStep(step.id);
    const stepsState = currentStore().steps;

    return ok(
      {
        step: { stepId: step.id, label: step.label },
        steps: { count: stepsState.list.length, currentStepId: stepsState.currentStepId },
      },
      { mutating: true }
    );
  }

  if (tool === 'steps.insert') {
    const label = String((args as any).label || '').trim();
    if (!label) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'label is required' });
    }
    const afterStepId = (args as any).afterStepId as string | null;
    const select = (args as any).select !== false;

    const store = currentStore();
    store.insertStep(afterStepId, label);
    const list = currentStore().steps.list;
    // Find the newly inserted step (it's at afterStepId's index + 1, or first if afterStepId is null)
    const afterIdx = afterStepId ? list.findIndex((s) => s.id === afterStepId) : -1;
    const step = list[afterIdx + 1];
    if (!step) {
      throw new ToolExecutionError({ code: 'INTERNAL_ERROR', message: 'Failed to insert step' });
    }
    if (select) currentStore().selectStep(step.id);
    const stepsState = currentStore().steps;

    return ok(
      {
        step: { stepId: step.id, label: step.label },
        steps: { count: stepsState.list.length, currentStepId: stepsState.currentStepId },
      },
      { mutating: true }
    );
  }

  if (tool === 'steps.select') {
    const store = currentStore();
    const before = store.steps.currentStepId;
    const stepId = (args as any).stepId as string | null;

    if (stepId === null) {
      if (before === null) return ok({ currentStepId: null }, { mutating: false });
      store.dispatch('select_step', (state) => ({ steps: { ...state.steps, currentStepId: null } }));
      return ok({ currentStepId: null }, { mutating: true });
    }

    if (before === stepId) return ok({ currentStepId: stepId }, { mutating: false });
    store.selectStep(stepId);
    return ok({ currentStepId: stepId }, { mutating: true });
  }

  if (tool === 'steps.delete') {
    const store = currentStore();
    const stepId = String((args as any).stepId || '');
    const exists = store.steps.list.some((s) => s.id === stepId);
    if (!exists) {
      return ok(
        {
          deleted: false,
          stepId,
          steps: { count: store.steps.list.length, currentStepId: store.steps.currentStepId },
        },
        { mutating: false }
      );
    }
    store.deleteStep(stepId);
    const stepsState = currentStore().steps;
    return ok(
      {
        deleted: true,
        stepId,
        steps: { count: stepsState.list.length, currentStepId: stepsState.currentStepId },
      },
      { mutating: true }
    );
  }

  if (tool === 'steps.move') {
    const store = currentStore();
    const stepId = String((args as any).stepId || '');
    const targetStepId = String((args as any).targetStepId || '');
    const position = String((args as any).position || 'before') as 'before' | 'after';

    const list = store.steps.list;
    const fromIndex = list.findIndex((s) => s.id === stepId);
    const toIndexRaw = list.findIndex((s) => s.id === targetStepId);
    if (fromIndex < 0 || toIndexRaw < 0 || stepId === targetStepId) {
      return ok({ moved: false, order: list.map((s) => s.id) }, { mutating: false });
    }

    let insertIndex = position === 'after' ? toIndexRaw + 1 : toIndexRaw;
    if (fromIndex < insertIndex) insertIndex -= 1;
    if (insertIndex === fromIndex) {
      return ok({ moved: false, order: list.map((s) => s.id) }, { mutating: false });
    }

    store.dispatch('move_step', (state) => {
      const next = [...state.steps.list];
      const from = next.findIndex((s) => s.id === stepId);
      const toRaw = next.findIndex((s) => s.id === targetStepId);
      if (from < 0 || toRaw < 0 || from === toRaw) return { steps: state.steps };
      let to = position === 'after' ? toRaw + 1 : toRaw;
      const [item] = next.splice(from, 1);
      if (from < to) to -= 1;
      next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
      return { steps: { ...state.steps, list: next } };
    });

    const nextOrder = currentStore().steps.list.map((s) => s.id);
    return ok({ moved: true, order: nextOrder }, { mutating: true });
  }

  if (tool === 'steps.update_snapshot') {
    const store = currentStore();
    const stepId = String((args as any).stepId || '');
    const exists = store.steps.list.some((s) => s.id === stepId);
    if (!exists) {
      return ok({ updated: false, stepId }, { mutating: false });
    }

    // 1. Capture current state as new snapshot
    store.updateStepSnapshot(stepId);

    // 2. Reset current visual position to "pre-step" state so next Run shows movement.
    //    Also reset manualTransformById to the GLOBAL start (before step[0]) so that
    //    resetToManualTransforms() correctly seeds step 1's "from", not the middle of the sequence.
    const updatedStore = currentStore();
    const stepIndex = updatedStore.steps.list.findIndex((s) => s.id === stepId);
    const updatedStep = updatedStore.steps.list.find((s) => s.id === stepId);
    const prevStep = stepIndex > 0 ? updatedStore.steps.list[stepIndex - 1] : null;
    const prevSnapshot = prevStep?.snapshotOverridesById ?? {};
    const newSnapshot = updatedStep?.snapshotOverridesById ?? {};
    // baseManualTransforms = manualTransformById captured at addStep time (the true pre-step state)
    const baseManual = updatedStep?.baseManualTransforms ?? {};
    // step[0].baseManualTransforms is the "before all steps" baseline for manualTransformById
    const step0 = updatedStore.steps.list[0];
    const globalBaseManual = step0?.baseManualTransforms ?? {};

    for (const partId of Object.keys(newSnapshot)) {
      // Visual reset: part jumps to end-of-previous-step so user sees it ready for this step
      const preStepTransform =
        prevSnapshot[partId] ??        // end of previous step (multi-step case)
        baseManual[partId] ??          // manual position before step was created
        updatedStore.parts.initialTransformById[partId]; // absolute fallback
      if (!preStepTransform) continue;
      updatedStore.setPartOverrideSilent(partId, preStepTransform);

      // Playback baseline: always reset to before-all-steps so step 1's from ≠ step 1's to
      const globalStartTransform =
        globalBaseManual[partId] ??
        updatedStore.parts.initialTransformById[partId];
      if (globalStartTransform) {
        updatedStore.setManualTransform(partId, globalStartTransform);
      }
    }

    return ok({ updated: true, stepId }, { mutating: true });
  }

  if (tool === 'steps.playback_start') {
    const store = currentStore();
    const durationMs = (args as any).durationMs as number | undefined;
    if (store.playback.running) return ok({ running: true }, { mutating: false });
    store.startPlayback(durationMs ?? store.playback.durationMs);
    return ok({ running: true }, { mutating: true });
  }

  if (tool === 'steps.playback_start_at') {
    const store = currentStore();
    const stepId = String((args as any).stepId || '');
    const durationMs = (args as any).durationMs as number | undefined;
    if (!store.steps.list.some((s) => s.id === stepId)) {
      return ok({ running: false, targetStepId: stepId }, { mutating: false });
    }
    if (store.playback.running) store.stopPlayback();
    const fromStepId = store.steps.currentStepId ?? undefined;
    store.startPlaybackAt(stepId, durationMs ?? store.playback.durationMs, fromStepId);
    return ok({ running: true, targetStepId: stepId }, { mutating: true });
  }

  if (tool === 'steps.playback_stop') {
    const store = currentStore();
    if (!store.playback.running) return ok({ running: false }, { mutating: false });
    store.stopPlayback();
    return ok({ running: false }, { mutating: true });
  }

  if (tool === 'vlm.add_images') {
    const inputImages = ((args as any).images ?? []) as Array<{ name: string; mime?: string; dataBase64: string }>;
    if (!Array.isArray(inputImages) || inputImages.length === 0) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'images must be a non-empty array' });
    }

    if (typeof atob !== 'function') {
      throw new ToolExecutionError({ code: 'INTERNAL_ERROR', message: 'atob is not available for base64 decoding' });
    }

    const files = inputImages.map((img) => {
      const name = String(img.name || 'image.png');
      const mime = String(img.mime || 'image/png');
      const binary = atob(img.dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name, { type: mime });
    });

    const store = currentStore();
    const beforeCount = store.vlm.images.length;
    store.addVlmImages(files);
    const afterImages = currentStore().vlm.images;
    const added = afterImages.slice(beforeCount).map((img) => ({ imageId: img.id, name: img.name }));
    return ok({ added, count: afterImages.length }, { mutating: added.length > 0 });
  }

  if (tool === 'vlm.move_image') {
    const store = currentStore();
    const imageId = String((args as any).imageId || '');
    const delta = Number((args as any).delta || 0);
    if (!imageId) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'imageId is required' });
    }
    if (![ -1, 0, 1 ].includes(delta)) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'delta must be -1, 0, or 1' });
    }
    if (delta === 0) {
      return ok({ moved: false, count: store.vlm.images.length }, { mutating: false });
    }
    const beforeOrder = store.vlm.images.map((img) => img.id).join('|');
    store.moveVlmImage(imageId, delta < 0 ? -1 : 1);
    const afterImages = currentStore().vlm.images;
    const afterOrder = afterImages.map((img) => img.id).join('|');
    return ok({ moved: beforeOrder !== afterOrder, count: afterImages.length }, { mutating: beforeOrder !== afterOrder });
  }

  if (tool === 'vlm.remove_image') {
    const store = currentStore();
    const imageId = String((args as any).imageId || '');
    const beforeCount = store.vlm.images.length;
    store.removeVlmImage(imageId);
    const afterImages = currentStore().vlm.images;
    return ok({ removed: afterImages.length !== beforeCount, count: afterImages.length }, { mutating: afterImages.length !== beforeCount });
  }

  if (tool === 'vlm.analyze') {
    const store = currentStore();
    const requestedIds = (args as any).imageIds as string[] | undefined;
    const images = requestedIds?.length
      ? store.vlm.images.filter((img) => requestedIds.includes(img.id))
      : store.vlm.images;

    if (images.length === 0) {
      throw new ToolExecutionError({ code: 'INVALID_ARGUMENT', message: 'No images available for analysis' });
    }

    store.setVlmAnalyzing(true);

    const fileToBase64 = (file: File) =>
      new Promise<{ name: string; data: string; mime: string }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve({ name: file.name, data: base64, mime: file.type || 'image/png' });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

    try {
      const payload = await Promise.all(images.map((img) => fileToBase64(img.file)));
      const partsCtx = store.parts.order.map((id) => ({ id, name: store.parts.byId[id]?.name || id }));
      const res: any = await v2Client.request('vlm_analyze', { images: payload, parts: partsCtx });
      const result = res?.result || res;
      store.setVlmResult(result);
      store.setVlmAnalyzing(false);
      return ok({ analyzing: false, result }, { mutating: true });
    } catch (e: any) {
      store.setVlmAnalyzing(false);
      throw new ToolExecutionError({
        code: 'INTERNAL_ERROR',
        message: e?.message || 'VLM analyze failed',
        detail: e,
        suggestedToolCalls: [{ tool: 'ui.get_sync_state', args: {} }],
      });
    }
  }

  if (tool === 'vlm.capture_for_mate') {
    const input = args as any;

    // Resolve source and target parts.
    const srcPart = resolvePart(input.sourcePart as PartRef);
    const tgtPart = resolvePart(input.targetPart as PartRef);

    // Filter angles if caller specified a subset.
    const angleLabels: string[] | undefined = input.angleLabels;
    const selectedAngles = angleLabels?.length
      ? DEFAULT_ANGLES.filter((a) => angleLabels.includes(a.label))
      : DEFAULT_ANGLES;

    // Capture multi-angle screenshots.
    let captureResults;
    try {
      captureResults = await captureMultiAngles({
        maxWidthPx: Number(input.maxWidthPx ?? 512),
        maxHeightPx: Number(input.maxHeightPx ?? 384),
        angles: selectedAngles,
      });
    } catch (captureErr: any) {
      throw new ToolExecutionError({
        code: 'UNSUPPORTED_OPERATION',
        message: `Multi-angle capture failed: ${captureErr?.message || 'unknown'}`,
        recoverable: true,
      });
    }

    // Send images to server-side VLM for mate parameter inference.
    const store = currentStore();
    const sceneState = {
      parts: store.parts.order.map((id) => ({
        id,
        name: store.parts.byId[id]?.name ?? id,
        position: store.getPartTransform(id)?.position ?? [0, 0, 0],
      })),
      sourcePart: { id: srcPart.partId, name: srcPart.partName },
      targetPart: { id: tgtPart.partId, name: tgtPart.partName },
      userText: String(input.userText ?? ''),
    };

    const confidenceThreshold = Number(input.confidenceThreshold ?? 0.75);
    let vlmInference: Record<string, unknown> | null = null;

    try {
      const raw: any = await v2Client.request('vlm_mate_analyze', {
        images: captureResults.map((r) => ({ angle: r.angle, dataUrl: r.dataUrl })),
        sceneState,
      });
      if (raw?.inference && typeof raw.inference === 'object') {
        vlmInference = raw.inference as Record<string, unknown>;
      }
    } catch {
      // VLM call failed — return meetsThreshold=false so caller falls back to NLP.
      vlmInference = null;
    }

    const confidence = typeof vlmInference?.confidence === 'number' ? vlmInference.confidence : 0;
    const meetsThreshold = vlmInference !== null && confidence >= confidenceThreshold;

    return ok(
      {
        capturedAngles: captureResults.map((r) => r.angle),
        imageCount: captureResults.length,
        vlmInference: meetsThreshold ? vlmInference : null,
        confidenceThreshold,
        meetsThreshold,
        fallbackReason: !meetsThreshold
          ? vlmInference === null
            ? 'VLM call failed or returned no result'
            : `VLM confidence ${confidence.toFixed(2)} < threshold ${confidenceThreshold}`
          : undefined,
      },
      { mutating: false }
    );
  }

  if (tool === 'history.undo') {
    const store = currentStore();
    if (store.history.past.length === 0) {
      throw new ToolExecutionError({ code: 'HISTORY_EMPTY', message: 'Nothing to undo' });
    }
    store.undo();
    return ok(
      {
        historyId: `undo-${crypto.randomUUID()}`,
        selection: runtimeState.selection,
        preview: previewFromRuntimeOrNull(),
      },
      { mutating: true }
    );
  }

  if (tool === 'history.redo') {
    const store = currentStore();
    if (store.history.future.length === 0) {
      throw new ToolExecutionError({ code: 'HISTORY_EMPTY', message: 'Nothing to redo' });
    }
    store.redo();
    return ok(
      {
        historyId: `redo-${crypto.randomUUID()}`,
        selection: runtimeState.selection,
        preview: previewFromRuntimeOrNull(),
      },
      { mutating: true }
    );
  }

  if (tool === 'interaction.rotate_drag_begin') {
    const input = args as any;
    const part = resolvePart(input.part);
    const startTransform = getPartTransformOrThrow(part.partId);
    const sessionId = crypto.randomUUID();
    const previewId = crypto.randomUUID();

    runtimeState.rotateSessions.set(sessionId, {
      sessionId,
      part,
      startPointer: input.pointerNdc,
      startTransform: {
        position: [...startTransform.position],
        quaternion: [...startTransform.quaternion],
        scale: [...startTransform.scale],
      },
      previewId,
    });

    ensurePreviewBeforeTransform(part.partId);
    runtimeState.preview = {
      previewId,
      planId: `drag-${sessionId}`,
      active: true,
      scrubT: 1,
      partId: part.partId,
    };

    return ok(
      {
        sessionId,
        part,
        preview: {
          previewId,
          planId: `drag-${sessionId}`,
          active: true,
          scrubT: 1,
        },
        transform: {
          position: startTransform.position,
          quaternion: startTransform.quaternion,
          scale: startTransform.scale,
          space: 'world',
        },
      },
      { mutating: true }
    );
  }

  if (tool === 'interaction.rotate_drag_update') {
    const input = args as any;
    const session = runtimeState.rotateSessions.get(input.sessionId);
    if (!session) {
      throw new ToolExecutionError({ code: 'NOT_FOUND', message: 'Rotate drag session not found' });
    }

    const start = new THREE.Vector2(session.startPointer[0], session.startPointer[1]);
    const now = new THREE.Vector2(input.pointerNdc[0], input.pointerNdc[1]);

    const projectArcball = (v: THREE.Vector2) => {
      const d = v.x * v.x + v.y * v.y;
      if (d <= 1) return new THREE.Vector3(v.x, v.y, Math.sqrt(1 - d)).normalize();
      return new THREE.Vector3(v.x, v.y, 0).normalize();
    };

    const from = projectArcball(start);
    const to = projectArcball(now);
    let qDelta = new THREE.Quaternion().setFromUnitVectors(from, to).normalize();

    const snapDeg = input.snapDeg ? Number(input.snapDeg) : 0;
    if (snapDeg > 0) {
      const angle = 2 * Math.acos(Math.max(-1, Math.min(1, qDelta.w)));
      const axisRaw = new THREE.Vector3(qDelta.x, qDelta.y, qDelta.z);
      const axis = normalize(axisRaw, new THREE.Vector3(0, 1, 0));
      const snappedAngle = THREE.MathUtils.degToRad(
        Math.round(THREE.MathUtils.radToDeg(angle) / snapDeg) * snapDeg
      );
      qDelta = new THREE.Quaternion().setFromAxisAngle(axis, snappedAngle).normalize();
    }

    const startQuat = quat4(session.startTransform.quaternion);
    const nextQuat = qDelta.multiply(startQuat).normalize();

    const nextTransform: PartTransform = {
      position: session.startTransform.position,
      quaternion: tuple4(nextQuat),
      scale: session.startTransform.scale,
    };

    currentStore().setPartOverrideSilent(session.part.partId, nextTransform);

    return ok(
      {
        sessionId: session.sessionId,
        part: session.part,
        preview: {
          previewId: session.previewId,
          planId: `drag-${session.sessionId}`,
          active: true,
          scrubT: 1,
        },
        transform: {
          position: nextTransform.position,
          quaternion: nextTransform.quaternion,
          scale: nextTransform.scale,
          space: 'world',
        },
      },
      { mutating: true }
    );
  }

  if (tool === 'interaction.rotate_drag_end') {
    const input = args as any;
    const session = runtimeState.rotateSessions.get(input.sessionId);
    if (!session) {
      throw new ToolExecutionError({ code: 'NOT_FOUND', message: 'Rotate drag session not found' });
    }

    const commit = input.commit !== false;
    if (commit) {
      const current = getPartTransformOrThrow(session.part.partId);
      currentStore().setPartOverride(session.part.partId, current);
    } else {
      currentStore().setPartOverrideSilent(session.part.partId, session.startTransform);
      restorePreviewTransformIfNeeded(session.part.partId);
    }

    runtimeState.rotateSessions.delete(session.sessionId);
    clearPreviewState();

    return ok(
      {
        sessionId: session.sessionId,
        committed: commit,
        historyId: commit ? `drag-${crypto.randomUUID()}` : undefined,
      },
      { mutating: true }
    );
  }

  if (tool === 'action.auto_assemble') {
    const input = args as any;
    const store = currentStore();
    const allParts = store.parts.order.map((id) => ({
      id,
      name: store.parts.byId[id]?.name || id,
    }));
    if (allParts.length < 2) {
      return ok({ totalSteps: 0, completedSteps: 0, steps: [], reason: 'need_at_least_2_parts' }, { mutating: false });
    }

    // Capture overview image
    let overviewImages: { name: string; data: string; mime: string }[] = [];
    try {
      const captured = await runTool('view.capture_image' as MCPToolName, {
        format: 'jpeg',
        jpegQuality: 0.85,
        maxWidthPx: 640,
        maxHeightPx: 480,
      } as any);
      if (captured.ok && (captured as any).data?.dataUrl) {
        const dataUrl: string = (captured as any).data.dataUrl;
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        overviewImages = [{ name: 'overview.jpg', data: base64, mime: 'image/jpeg' }];
      }
    } catch {
      // proceed without image
    }

    // Ask server to infer assembly sequence
    let steps: Array<{ sourceName: string; targetName: string; instruction: string; stepIndex: number }> = [];
    try {
      const res: any = await v2Client.request('vlm_auto_assemble', {
        images: overviewImages,
        parts: allParts,
      });
      const serverSteps = res?.result?.steps || res?.steps || [];
      if (Array.isArray(serverSteps)) {
        steps = serverSteps;
      }
    } catch {
      // Fallback: linear sequence using first part as base
      const basePart = allParts[0];
      steps = allParts.slice(1).map((p, i) => ({
        sourceName: p.name,
        targetName: i === 0 ? basePart.name : allParts[i].name,
        instruction: `Mate ${p.name} to ${i === 0 ? basePart.name : allParts[i].name}`,
        stepIndex: i,
      }));
    }

    const maxSteps = typeof input.maxSteps === 'number' ? Math.min(input.maxSteps, 20) : 20;
    const stepsToRun = steps.slice(0, maxSteps);
    const completedSteps: typeof stepsToRun = [];

    for (const step of stepsToRun) {
      try {
        const sourcePart = resolvePart({ partName: step.sourceName });
        const targetPart = resolvePart({ partName: step.targetName });
        await runTool('action.smart_mate_execute' as MCPToolName, {
          sourcePart: { partId: sourcePart.partId },
          targetPart: { partId: targetPart.partId },
          instruction: step.instruction,
          commit: true,
          pushHistory: true,
          stepLabel: step.instruction,
        } as any);
        await runTool('steps.add' as MCPToolName, {
          label: step.instruction,
          select: true,
        } as any);
        completedSteps.push(step);
      } catch {
        // skip failed step, continue
      }
    }

    return ok(
      {
        totalSteps: stepsToRun.length,
        completedSteps: completedSteps.length,
        steps: completedSteps,
      },
      { mutating: completedSteps.length > 0 }
    );
  }

  // ── mate.save_recipe ───────────────────────────────────────────────────────
  if (tool === 'mate.save_recipe') {
    const input = args as {
      sourceName: string;
      targetName: string;
      sourceFace: string;
      targetFace: string;
      sourceMethod?: string;
      targetMethod?: string;
      note?: string;
      whyDescription?: string;
      pattern?: string;
      antiPattern?: string;
      geometrySignal?: string;
    };
    if (!input.sourceName || !input.targetName || !input.sourceFace || !input.targetFace) {
      throw new ToolExecutionError({
        code: 'INVALID_ARGUMENT',
        message: 'mate.save_recipe requires sourceName, targetName, sourceFace, targetFace',
        suggestedToolCalls: [],
      });
    }
    const saved = await saveMateRecipe(input);
    return ok({
      saved,
      message: saved
        ? `Saved mate recipe: ${input.sourceName} (${input.sourceFace}) ↔ ${input.targetName} (${input.targetFace})`
        : 'Failed to save recipe (server error)',
    }, { mutating: false });
  }

  // ── query.extract_features ─────────────────────────────────────────────────
  if (tool === 'query.extract_features') {
    const input = args as { part: PartRef };
    const part = resolvePart(input.part);
    const obj = getV2ObjectByPartId(part.partId);
    if (!obj) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `Part '${part.partName}' (${part.partId}) not found in scene`,
        suggestedToolCalls: [{ tool: 'query.scene_state', args: {} }],
      });
    }

    // Update world matrix so feature extractor sees current transforms
    const store = currentStore();
    const partTransform = store.parts.overridesById[part.partId] || store.parts.initialTransformById[part.partId];
    if (partTransform) {
      obj.position.set(partTransform.position[0], partTransform.position[1], partTransform.position[2]);
      obj.quaternion.set(partTransform.quaternion[0], partTransform.quaternion[1], partTransform.quaternion[2], partTransform.quaternion[3]);
    }
    obj.updateWorldMatrix(true, true);

    const features = extractFeatures(obj, part.partId);

    return ok({
      partId: part.partId,
      features,
      featureCount: features.length,
    }, { mutating: false, debug: { partName: part.partName } });
  }

  // ── query.generate_candidates ──────────────────────────────────────────────
  if (tool === 'query.generate_candidates') {
    const input = args as { sourcePart: PartRef; targetPart: PartRef; maxCandidates?: number; vlmRerank?: boolean };
    const sourcePart = resolvePart(input.sourcePart);
    const targetPart = resolvePart(input.targetPart);

    const sourceObj = getV2ObjectByPartId(sourcePart.partId);
    const targetObj = getV2ObjectByPartId(targetPart.partId);

    if (!sourceObj) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `Source part '${sourcePart.partName}' not found in scene`,
        suggestedToolCalls: [{ tool: 'query.scene_state', args: {} }],
      });
    }
    if (!targetObj) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `Target part '${targetPart.partName}' not found in scene`,
        suggestedToolCalls: [{ tool: 'query.scene_state', args: {} }],
      });
    }

    // Sync transforms from store to Three.js objects
    const store = currentStore();
    const syncTransform = (obj: THREE.Object3D, partId: string) => {
      const t = store.parts.overridesById[partId] || store.parts.initialTransformById[partId];
      if (t) {
        obj.position.set(t.position[0], t.position[1], t.position[2]);
        obj.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
      }
      obj.updateWorldMatrix(true, true);
    };
    syncTransform(sourceObj, sourcePart.partId);
    syncTransform(targetObj, targetPart.partId);

    const sourceFeatures = extractFeatures(sourceObj, sourcePart.partId);
    const targetFeatures = extractFeatures(targetObj, targetPart.partId);

    // Fetch demonstration priors from server (non-blocking — best-effort)
    let demonstrationPriors: DemonstrationPriorScore[] = [];
    try {
      const demoResp = await v2Client.request('agent.find_relevant_demonstrations', {
        sourceName: sourcePart.partName,
        targetName: targetPart.partName,
        featureTypeHints: [...new Set([
          ...sourceFeatures.map(f => f.type),
          ...targetFeatures.map(f => f.type),
        ])],
      }) as { scores?: DemonstrationPriorScore[] };
      demonstrationPriors = demoResp?.scores ?? [];
    } catch {
      // Demo priors are optional — proceed without them
    }

    const maxCandidates = typeof input.maxCandidates === 'number' ? input.maxCandidates : 10;
    const candidates = generateMatingCandidates(
      sourceFeatures,
      targetFeatures,
      sourcePart.partId,
      targetPart.partId,
      { maxCandidates, demonstrationPriors },
      sourceObj,
      targetObj
    );

    // Optional VLM rerank: send top 3 candidates to LLM for semantic reranking
    const vlmRerank = input.vlmRerank === true;
    if (vlmRerank && candidates.length > 0) {
      try {
        const top3 = candidates.slice(0, 3);
        const rrPayload = {
          source: sourcePart.partName,
          target: targetPart.partName,
          candidates: top3.map(c => ({
            id: c.id,
            description: c.description,
            primaryFeatureTypes: c.featurePairs.length > 0
              ? [c.featurePairs[0].sourceFeature.type, c.featurePairs[0].targetFeature.type]
              : [],
            score: c.totalScore,
          })),
        };
        const rrRes: any = await v2Client.request('agent.vlm_rerank_candidates', rrPayload)
          .catch(() => null);
        if (rrRes?.reranked && Array.isArray(rrRes.reranked)) {
          for (const rr of rrRes.reranked) {
            const c = candidates.find(x => x.id === rr.candidateId);
            if (c && typeof rr.semanticScore === 'number') {
              c.scoreBreakdown.vlmRerank = rr.semanticScore;
              c.totalScore = Math.min(1, c.totalScore + rr.semanticScore * 0.15);
              if (rr.reason) c.diagnostics.push(`vlm_rerank: ${rr.reason}`);
            }
          }
          // Re-sort after rerank
          candidates.sort((a, b) => b.totalScore - a.totalScore);
        }
      } catch {
        // VLM rerank is best-effort — log warning and continue
        console.warn('[mcpToolExecutor] query.generate_candidates VLM rerank failed — returning original candidates');
      }
    }

    // Score solver families based on geometry features, demo priors, and candidates
    const solverScoringResult = scoreSolvers({
      sourceFeatures,
      targetFeatures,
      demonstrationPriors,
      existingCandidates: candidates,
    });

    // Store full candidates in registry for later lookup
    const regKey = candidateRegistryKey(sourcePart.partId, targetPart.partId);
    candidateRegistry.set(regKey, candidates);

    // Return a serialization-friendly summary (featurePairs contain full feature objects
    // which could be large — summarize them instead of embedding).
    const candidateSummaries = candidates.map(c => ({
      id: c.id,
      sourcePartId: c.sourcePartId,
      targetPartId: c.targetPartId,
      totalScore: c.totalScore,
      description: c.description,
      diagnostics: c.diagnostics,
      scoreBreakdown: c.scoreBreakdown,
      featurePairCount: c.featurePairs.length,
      primaryPairDescription: c.featurePairs[0]
        ? `${c.featurePairs[0].sourceFeature.type} ↔ ${c.featurePairs[0].targetFeature.type}`
        : undefined,
    }));

    return ok({
      sourcePartId: sourcePart.partId,
      targetPartId: targetPart.partId,
      candidates: candidateSummaries,
      candidateCount: candidates.length,
      solverRecommendation: {
        recommendedSolver: solverScoringResult.recommendedSolver,
        confidence: solverScoringResult.confidence,
        diagnostics: solverScoringResult.diagnostics,
      },
    }, {
      mutating: false,
      debug: {
        sourceFeatureCount: sourceFeatures.length,
        targetFeatureCount: targetFeatures.length,
        vlmRerank,
        demonstrationPriorCount: demonstrationPriors.length,
        topDemoScore: demonstrationPriors[0]?.totalScore ?? 0,
        recommendedSolver: solverScoringResult.recommendedSolver,
        solverScores: solverScoringResult.rankedSolvers.map(s => ({
          solver: s.solver, score: s.totalScore, reasons: s.reasons, implemented: s.implemented,
        })),
      },
    });
  }

  // ── query.candidate_detail ─────────────────────────────────────────────────
  if (tool === 'query.candidate_detail') {
    const input = args as { sourcePart: PartRef; targetPart: PartRef; candidateId: string };
    const sourcePart = resolvePart(input.sourcePart);
    const targetPart = resolvePart(input.targetPart);

    const regKey = candidateRegistryKey(sourcePart.partId, targetPart.partId);
    const stored = candidateRegistry.get(regKey);
    if (!stored || stored.length === 0) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `No candidates found for ${sourcePart.partName} → ${targetPart.partName}. Run query.generate_candidates first.`,
        suggestedToolCalls: [{ tool: 'query.generate_candidates', args: { sourcePart: input.sourcePart, targetPart: input.targetPart } }],
      });
    }

    const candidate = stored.find(c => c.id === input.candidateId);
    if (!candidate) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `Candidate '${input.candidateId}' not found in registry for ${sourcePart.partName} → ${targetPart.partName}.`,
        suggestedToolCalls: [{ tool: 'query.generate_candidates', args: { sourcePart: input.sourcePart, targetPart: input.targetPart } }],
      });
    }

    return ok({
      candidate: {
        id: candidate.id,
        sourcePartId: candidate.sourcePartId,
        targetPartId: candidate.targetPartId,
        totalScore: candidate.totalScore,
        description: candidate.description,
        diagnostics: candidate.diagnostics,
        scoreBreakdown: candidate.scoreBreakdown,
        featurePairs: candidate.featurePairs.map(fp => ({
          sourceFeatureType: fp.sourceFeature.type,
          targetFeatureType: fp.targetFeature.type,
          compatibilityScore: fp.compatibilityScore,
          dimensionFitScore: fp.dimensionFitScore,
          axisAlignmentScore: fp.axisAlignmentScore,
          notes: fp.notes,
        })),
        transform: candidate.transform ? {
          translation: candidate.transform.translation,
          rotation: candidate.transform.rotation,
          approachDirection: candidate.transform.approachDirection,
          method: candidate.transform.method,
          residualError: candidate.transform.residualError,
          diagnostics: candidate.transform.diagnostics,
        } : undefined,
      },
    }, { mutating: false });
  }

  // ── action.solve_candidate ─────────────────────────────────────────────────
  if (tool === 'action.solve_candidate') {
    const input = args as { sourcePart: PartRef; targetPart: PartRef; candidateId: string };
    const sourcePart = resolvePart(input.sourcePart);
    const targetPart = resolvePart(input.targetPart);

    const sourceObj = getV2ObjectByPartId(sourcePart.partId);
    const targetObj = getV2ObjectByPartId(targetPart.partId);
    if (!sourceObj) {
      throw new ToolExecutionError({ code: 'NOT_FOUND', message: `Source part '${sourcePart.partName}' not in scene`, suggestedToolCalls: [] });
    }
    if (!targetObj) {
      throw new ToolExecutionError({ code: 'NOT_FOUND', message: `Target part '${targetPart.partName}' not in scene`, suggestedToolCalls: [] });
    }

    const regKey = candidateRegistryKey(sourcePart.partId, targetPart.partId);
    const stored = candidateRegistry.get(regKey);
    const candidate = stored?.find(c => c.id === input.candidateId);
    if (!candidate) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `Candidate '${input.candidateId}' not found. Run query.generate_candidates first.`,
        suggestedToolCalls: [{ tool: 'query.generate_candidates', args: { sourcePart: input.sourcePart, targetPart: input.targetPart } }],
      });
    }

    // Sync transforms from store
    const store = currentStore();
    const syncT = (obj: THREE.Object3D, partId: string) => {
      const t = store.parts.overridesById[partId] || store.parts.initialTransformById[partId];
      if (t) { obj.position.set(t.position[0], t.position[1], t.position[2]); obj.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]); }
      obj.updateWorldMatrix(true, true);
    };
    syncT(sourceObj, sourcePart.partId);
    syncT(targetObj, targetPart.partId);

    const solution = solveAlignment(sourceObj, targetObj, candidate.featurePairs);
    const diagnostics = solution?.diagnostics ?? ['Solver returned null'];

    return ok({
      solution: solution ? {
        translation: solution.translation,
        rotation: solution.rotation,
        approachDirection: solution.approachDirection,
        method: solution.method,
        residualError: solution.residualError,
        diagnostics: solution.diagnostics,
      } : null,
      diagnostics,
    }, { mutating: false });
  }

  // ── action.apply_candidate ─────────────────────────────────────────────────
  if (tool === 'action.apply_candidate') {
    const input = args as {
      sourcePart: PartRef;
      targetPart: PartRef;
      candidateId: string;
      commit?: boolean;
      pushHistory?: boolean;
      stepLabel?: string;
    };
    const sourcePart = resolvePart(input.sourcePart);
    const targetPart = resolvePart(input.targetPart);
    const commit = input.commit !== false; // default true

    const sourceObj = getV2ObjectByPartId(sourcePart.partId);
    const targetObj = getV2ObjectByPartId(targetPart.partId);
    if (!sourceObj) {
      throw new ToolExecutionError({ code: 'NOT_FOUND', message: `Source part '${sourcePart.partName}' not in scene`, suggestedToolCalls: [] });
    }
    if (!targetObj) {
      throw new ToolExecutionError({ code: 'NOT_FOUND', message: `Target part '${targetPart.partName}' not in scene`, suggestedToolCalls: [] });
    }

    const regKey = candidateRegistryKey(sourcePart.partId, targetPart.partId);
    const stored = candidateRegistry.get(regKey);
    const candidate = stored?.find(c => c.id === input.candidateId);
    if (!candidate) {
      throw new ToolExecutionError({
        code: 'NOT_FOUND',
        message: `Candidate '${input.candidateId}' not found. Run query.generate_candidates first.`,
        suggestedToolCalls: [{ tool: 'query.generate_candidates', args: { sourcePart: input.sourcePart, targetPart: input.targetPart } }],
      });
    }

    // Sync transforms from store
    const storeAc = currentStore();
    const syncTAc = (obj: THREE.Object3D, partId: string) => {
      const t = storeAc.parts.overridesById[partId] || storeAc.parts.initialTransformById[partId];
      if (t) { obj.position.set(t.position[0], t.position[1], t.position[2]); obj.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]); }
      obj.updateWorldMatrix(true, true);
    };
    syncTAc(sourceObj, sourcePart.partId);
    syncTAc(targetObj, targetPart.partId);

    const solution = solveAlignment(sourceObj, targetObj, candidate.featurePairs);
    const diagnostics: string[] = solution?.diagnostics ?? ['Solver returned null'];

    if (!solution) {
      return ok({ applied: false, solution: null, diagnostics }, { mutating: false });
    }

    if (!commit) {
      return ok({
        applied: false,
        solution: {
          translation: solution.translation,
          rotation: solution.rotation,
          approachDirection: solution.approachDirection,
          method: solution.method,
          residualError: solution.residualError,
          diagnostics: solution.diagnostics,
        },
        diagnostics,
      }, { mutating: false });
    }

    // Apply the solution to the source object and update the store
    const newPos = new THREE.Vector3(...solution.translation);
    const currentWorldPos = new THREE.Vector3();
    sourceObj.getWorldPosition(currentWorldPos);
    const newWorldPos = currentWorldPos.clone().add(newPos);

    const newQuat = new THREE.Quaternion(...solution.rotation);
    // Combine: apply solution rotation on top of current world rotation
    const currentWorldQuat = new THREE.Quaternion();
    sourceObj.getWorldQuaternion(currentWorldQuat);
    const combinedQuat = newQuat.clone().multiply(currentWorldQuat);

    sourceObj.position.copy(newWorldPos);
    sourceObj.quaternion.copy(combinedQuat);
    sourceObj.updateWorldMatrix(true, true);

    // Convert world transform back to local (parent-relative)
    const localPos = sourceObj.parent
      ? newWorldPos.clone().applyMatrix4(new THREE.Matrix4().copy(sourceObj.parent.matrixWorld).invert())
      : newWorldPos.clone();

    const parentWorldQuat = new THREE.Quaternion();
    if (sourceObj.parent) sourceObj.parent.getWorldQuaternion(parentWorldQuat);
    const localQuat = parentWorldQuat.clone().invert().multiply(combinedQuat);

    const currentTransform = getPartTransformOrThrow(sourcePart.partId);
    const newTransform = {
      position: [localPos.x, localPos.y, localPos.z] as [number, number, number],
      quaternion: [localQuat.x, localQuat.y, localQuat.z, localQuat.w] as [number, number, number, number],
      scale: currentTransform.scale,
    };

    currentStore().setPartOverride(sourcePart.partId, newTransform);

    return ok({
      applied: true,
      solution: {
        translation: solution.translation,
        rotation: solution.rotation,
        approachDirection: solution.approachDirection,
        method: solution.method,
        residualError: solution.residualError,
        diagnostics: solution.diagnostics,
      },
      diagnostics,
    }, { mutating: true });
  }

  // ── mate.record_demonstration ──────────────────────────────────────────────
  if (tool === 'mate.record_demonstration') {
    const input = args as {
      sourcePartId: string;
      targetPartId: string;
      chosenCandidateId?: string;
      textExplanation?: string;
      antiPattern?: string;
      generalizedRule?: string;
      chosenFeaturePairs?: Array<{
        sourceFeatureId: string; sourceFeatureType: string;
        targetFeatureId: string; targetFeatureType: string;
        compatibilityScore: number; dimensionFitScore: number;
        axisAlignmentScore: number; notes: string[];
      }>;
      finalTransform?: {
        translation: [number, number, number];
        rotation: [number, number, number, number];
        approachDirection: [number, number, number];
        method: string;
        residualError: number;
      };
    };

    if (!input.sourcePartId || !input.targetPartId) {
      throw new ToolExecutionError({
        code: 'INVALID_ARGUMENT',
        message: 'mate.record_demonstration requires sourcePartId and targetPartId',
        suggestedToolCalls: [],
      });
    }

    // Resolve part names for the demonstration record
    const store = currentStore();
    const srcPartData = store.parts.byId[input.sourcePartId];
    const tgtPartData = store.parts.byId[input.targetPartId];
    const sourcePartName = srcPartData?.name ?? input.sourcePartId;
    const targetPartName = tgtPartData?.name ?? input.targetPartId;

    // Build a scene snapshot for learning
    const sceneSnapshot: Record<string, { position: [number, number, number]; quaternion: [number, number, number, number] }> = {};
    for (const partId of store.parts.order) {
      const t = store.parts.overridesById[partId] || store.parts.initialTransformById[partId];
      if (t) {
        sceneSnapshot[partId] = {
          position: [t.position[0], t.position[1], t.position[2]],
          quaternion: [t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]],
        };
      }
    }

    // If candidateId is provided, enrich from registry
    let chosenFeaturePairs = input.chosenFeaturePairs;
    let finalTransform = input.finalTransform;

    if (input.chosenCandidateId && !chosenFeaturePairs) {
      const regKey = candidateRegistryKey(input.sourcePartId, input.targetPartId);
      const storedCandidates = candidateRegistry.get(regKey);
      const foundCandidate = storedCandidates?.find(c => c.id === input.chosenCandidateId);
      if (foundCandidate) {
        // Serialize feature pairs (strip THREE.js objects)
        chosenFeaturePairs = foundCandidate.featurePairs.map(fp => ({
          sourceFeatureId: fp.sourceFeature.id,
          sourceFeatureType: fp.sourceFeature.type,
          targetFeatureId: fp.targetFeature.id,
          targetFeatureType: fp.targetFeature.type,
          compatibilityScore: fp.compatibilityScore,
          dimensionFitScore: fp.dimensionFitScore,
          axisAlignmentScore: fp.axisAlignmentScore,
          notes: fp.notes,
        }));

        // If we have a solved transform from generation time, use it
        if (!finalTransform && foundCandidate.transform) {
          finalTransform = {
            translation: foundCandidate.transform.translation,
            rotation: foundCandidate.transform.rotation,
            approachDirection: foundCandidate.transform.approachDirection,
            method: foundCandidate.transform.method,
            residualError: foundCandidate.transform.residualError,
          };
        }
      }
    }

    const demonstrationId = crypto.randomUUID();
    // Send the demonstration to the backend for storage
    let saved = false;
    try {
      await v2Client.request('agent.save_demonstration', {
        id: demonstrationId,
        timestamp: new Date().toISOString(),
        sourcePartId: input.sourcePartId,
        sourcePartName,
        targetPartId: input.targetPartId,
        targetPartName,
        chosenCandidateId: input.chosenCandidateId,
        chosenFeaturePairs,
        finalTransform,
        textExplanation: input.textExplanation,
        antiPattern: input.antiPattern,
        generalizedRule: input.generalizedRule,
        sceneSnapshot,
      });
      saved = true;
    } catch {
      // Server unavailable — that's OK, demonstration is not critical
      saved = false;
    }

    return ok({ demonstrationId, saved }, { mutating: false });
  }

  // ── query.ground_objects_from_utterance ────────────────────────────────────
  if (tool === 'query.ground_objects_from_utterance') {
    const input = args as {
      utterance: string;
      selectedPartIds?: string[];
      parsedSourceConcept?: string;
      parsedTargetConcept?: string;
    };

    // Ensure registry has basic cards before grounding
    syncRegistryIfEmpty();

    const heuristicResult = groundObjects(input.utterance, {
      selectedPartIds: input.selectedPartIds,
      parsedConcepts: {
        sourceConcept: input.parsedSourceConcept,
        targetConcept: input.parsedTargetConcept,
      },
    });

    // LLM fallback if heuristic failed
    const result = await enrichGroundingWithLlm(
      input.utterance,
      heuristicResult,
      input.selectedPartIds,
    );

    const total = getAllCards().length;
    const labeled = getAllCards().filter(c => c.vlmCategory !== undefined).length;

    return ok({
      ...result,
      // If exactly resolved, provide a summary for the agent
      resolved: !result.needsClarification &&
        result.sourceCandidates.length > 0 &&
        result.targetCandidates.length > 0,
      topSource: result.sourceCandidates[0] ?? null,
      topTarget: result.targetCandidates[0] ?? null,
      registryStats: {
        totalParts: total,
        labeledParts: labeled,
        semanticCoverage: total > 0 ? Math.round((labeled / total) * 100) + '%' : '0%',
      },
    }, { mutating: false, debug: { diagnostics: result.diagnostics } });
  }

  // ── query.describe_scene_parts ─────────────────────────────────────────────
  if (tool === 'query.describe_scene_parts') {
    const input = args as { partIds?: string[]; includeUnlabeled?: boolean };
    // Ensure basic cards exist before describing
    syncRegistryIfEmpty();
    let cards = getAllCards();
    if (input.partIds?.length) {
      cards = cards.filter(c => input.partIds!.includes(c.partId));
    }
    if (!input.includeUnlabeled) {
      cards = cards.filter(c => c.vlmCategory !== undefined);
    }
    const total = getAllCards().length;
    const labeled = getAllCards().filter(c => c.vlmCategory !== undefined).length;
    const coverage = total > 0 ? labeled / total : 0;
    return ok({
      cards,
      totalParts: total,
      labeledParts: labeled,
      registryStats: {
        registeredParts: total,
        labeledParts: labeled,
        semanticCoverage: Math.round(coverage * 100) + '%',
        registryReady: coverage >= 0.5,
        message: coverage === 0
          ? '語意標籤尚未生成。請執行 query.refresh_part_semantics。'
          : coverage < 0.5
            ? `僅 ${labeled}/${total} 個零件已標籤，語意匹配準確度可能較低。`
            : `${labeled}/${total} 個零件已有語意標籤，語意匹配可用。`,
      },
    }, { mutating: false });
  }

  // ── query.refresh_part_semantics ───────────────────────────────────────────
  if (tool === 'query.refresh_part_semantics') {
    const input = args as { partIds?: string[] };
    // Ensure basic registry cards exist before VLM enrichment
    syncRegistryIfEmpty();
    const store = currentStore();
    const allParts = Object.values(store.parts.byId);
    const toRefresh = input.partIds?.length
      ? allParts.filter(p => input.partIds!.includes(p.id))
      : allParts;

    const results: Array<{ partId: string; partName: string; status: 'queued' | 'skipped' }> = [];

    for (const part of toRefresh.slice(0, 20)) {
      // Register basic card (ensures it exists in registry)
      registerPartBasic({
        partId: part.id,
        partName: part.name ?? part.id,
      });

      // Queue VLM labeling via WS request (non-blocking, best-effort)
      v2Client.request('agent.label_part', {
        partId: part.id,
        partName: part.name ?? part.id,
        geometrySummary: getCard(part.id)?.geometrySummary,
      }).then((resp: unknown) => {
        const r = resp as { label?: { vlmCategory?: string; vlmAliases?: string[]; vlmDescription?: string; vlmRoles?: string[]; confidence?: number } } | null;
        if (r?.label) {
          applyVlmLabel(part.id, r.label);
        }
      }).catch(() => { /* labeling is best-effort */ });

      results.push({ partId: part.id, partName: part.name ?? part.id, status: 'queued' });
    }

    return ok({ queued: results.length, results }, { mutating: false });
  }

  // ── query.plan_assembly_from_utterance ────────────────────────────────────
  if (tool === 'query.plan_assembly_from_utterance') {
    const input = args as { utterance: string; selectedPartIds?: string[] };

    // Step 1: Ensure registry is populated
    syncRegistryIfEmpty();

    // Step 2: Ground objects (heuristic + LLM fallback)
    const heuristicGrounding = groundObjects(input.utterance, {
      selectedPartIds: input.selectedPartIds,
    });
    const groundingResult = await enrichGroundingWithLlm(
      input.utterance,
      heuristicGrounding,
      input.selectedPartIds,
    );

    // Step 3: If clarification needed, return early
    if (
      groundingResult.needsClarification ||
      groundingResult.sourceCandidates.length === 0 ||
      groundingResult.targetCandidates.length === 0
    ) {
      return ok({
        status: 'needs_clarification' as const,
        clarificationQuestion: groundingResult.clarificationQuestion ?? '請問你想組裝哪兩個零件？',
        sourceCandidates: groundingResult.sourceCandidates.slice(0, 4).map(c => ({
          partId: c.partId, partName: c.partName, semanticLabel: c.semanticLabel, score: c.score,
        })),
        targetCandidates: groundingResult.targetCandidates.slice(0, 4).map(c => ({
          partId: c.partId, partName: c.partName, semanticLabel: c.semanticLabel, score: c.score,
        })),
        groundingDiagnostics: groundingResult.diagnostics,
        usedSelectionFallback: groundingResult.usedSelectionFallback,
        usedVlmRegistry: groundingResult.usedVlmRegistry,
      }, { mutating: false });
    }

    // Step 4: Resolve Three.js objects for the top candidates
    const topSource = groundingResult.sourceCandidates[0];
    const topTarget = groundingResult.targetCandidates[0];

    const sourceObj = getV2ObjectByPartId(topSource.partId);
    const targetObj = getV2ObjectByPartId(topTarget.partId);

    if (!sourceObj || !targetObj) {
      return ok({
        status: 'resolved_but_objects_not_found' as const,
        resolvedSource: { partId: topSource.partId, partName: topSource.partName, semanticLabel: topSource.semanticLabel },
        resolvedTarget: { partId: topTarget.partId, partName: topTarget.partName, semanticLabel: topTarget.semanticLabel },
        clarificationQuestion: null,
        groundingDiagnostics: [...groundingResult.diagnostics, 'Three.js objects not found for resolved parts'],
        usedSelectionFallback: groundingResult.usedSelectionFallback,
        usedVlmRegistry: groundingResult.usedVlmRegistry,
      }, { mutating: false });
    }

    // Step 5: Sync transforms from store to Three.js objects
    const store = currentStore();
    const syncT = (obj: THREE.Object3D, partId: string) => {
      const t = store.parts.overridesById[partId] || store.parts.initialTransformById[partId];
      if (t) {
        obj.position.set(t.position[0], t.position[1], t.position[2]);
        obj.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
      }
      obj.updateWorldMatrix(true, true);
    };
    syncT(sourceObj, topSource.partId);
    syncT(targetObj, topTarget.partId);

    // Step 6: Extract features and generate candidates
    const sourceFeatures = extractFeatures(sourceObj, topSource.partId);
    const targetFeatures = extractFeatures(targetObj, topTarget.partId);

    let demonstrationPriors: DemonstrationPriorScore[] = [];
    try {
      const demoResp = await v2Client.request('agent.find_relevant_demonstrations', {
        sourceName: topSource.partName,
        targetName: topTarget.partName,
        featureTypeHints: [...new Set([...sourceFeatures.map(f => f.type), ...targetFeatures.map(f => f.type)])],
      }) as { scores?: DemonstrationPriorScore[] };
      demonstrationPriors = demoResp?.scores ?? [];
    } catch { /* best-effort */ }

    const candidates = generateMatingCandidates(
      sourceFeatures, targetFeatures,
      topSource.partId, topTarget.partId,
      { maxCandidates: 5, demonstrationPriors },
      sourceObj, targetObj,
    );

    // Store candidates in registry for later apply
    const regKey = candidateRegistryKey(topSource.partId, topTarget.partId);
    candidateRegistry.set(regKey, candidates);

    // Fix A: Build planning constraints between grounding and solver scoring
    const extractedConcepts = (groundingResult as any).parsedConcepts;
    const targetExplicit = hasExplicitTargetInUtterance(
      input.utterance,
      extractedConcepts?.targetConcept,
    );
    const planConstraints = planAssemblyConstraints(
      input.utterance,
      topSource,
      topTarget,
      { targetExplicitlyMentioned: targetExplicit },
    );

    // Intent routing: merge preferred solver families from Feature-First Intent Router
    // into planConstraints so scorePlanConstraints() can boost the right solver family.
    const smartMateRouting = routeAssemblyIntent({
      instruction: input.utterance,
      sourceName: topSource.partName,
      targetName: topTarget.partName,
      geometryIntent: 'default', // geometry intent not yet computed at this stage
    });
    if (smartMateRouting.preferredSolverFamilies.length > 0 && planConstraints) {
      // Merge: prepend routing-preferred solvers before planner-preferred ones
      const merged = [
        ...smartMateRouting.preferredSolverFamilies,
        ...planConstraints.preferredSolverFamilies,
      ].filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate, keep order
      planConstraints.preferredSolverFamilies = merged;
    }
    console.log(`[intent-router/smart_mate] intent=${smartMateRouting.assemblyIntent} mode=${smartMateRouting.usedFeatureMode} preferredSolvers=[${planConstraints?.preferredSolverFamilies.join(', ')}]`);

    // Solver scoring with planning constraints
    const solverResult = scoreSolvers({
      sourceFeatures,
      targetFeatures,
      demonstrationPriors,
      existingCandidates: candidates,
      planConstraints,
    });

    const topCandidate = candidates[0];
    return ok({
      status: 'ready' as const,
      resolvedSource: { partId: topSource.partId, partName: topSource.partName, semanticLabel: topSource.semanticLabel },
      resolvedTarget: { partId: topTarget.partId, partName: topTarget.partName, semanticLabel: topTarget.semanticLabel },
      groundingDiagnostics: groundingResult.diagnostics,
      candidateCount: candidates.length,
      topCandidate: topCandidate ? {
        id: topCandidate.id,
        description: topCandidate.description,
        totalScore: topCandidate.totalScore,
        scoreBreakdown: topCandidate.scoreBreakdown as Record<string, unknown>,
      } : null,
      solverRecommendation: {
        recommendedSolver: solverResult.recommendedSolver,
        confidence: solverResult.confidence,
      },
      planningConstraints: {
        mustUseResolvedTarget: planConstraints.mustUseResolvedTarget,
        sourceEntityType: planConstraints.sourceEntityType,
        disallowSameCategorySelfStack: planConstraints.disallowSameCategorySelfStack,
        preferredSolverFamilies: planConstraints.preferredSolverFamilies,
        planningNotes: planConstraints.planningNotes,
      },
      intentRouting: {
        assemblyIntent: smartMateRouting.assemblyIntent,
        usedFeatureMode: smartMateRouting.usedFeatureMode,
        preferredFeatureTypes: smartMateRouting.preferredFeatureTypes,
        preferredSolverFamilies: smartMateRouting.preferredSolverFamilies,
        fallbackAllowed: smartMateRouting.fallbackAllowed,
        routingDiagnostics: smartMateRouting.routingDiagnostics,
      },
      usedSelectionFallback: groundingResult.usedSelectionFallback,
      usedVlmRegistry: groundingResult.usedVlmRegistry,
    }, {
      mutating: false,
      debug: { solverDiagnostics: solverResult.diagnostics },
    });
  }

  throw new ToolExecutionError({
    code: 'UNSUPPORTED_OPERATION',
    message: `Tool '${tool}' is not implemented in local executor`,
    suggestedToolCalls: [{ tool: 'query.list_mate_modes', args: {} }],
  });
}

export async function executeMcpToolRequest(request: MCPToolRequest): Promise<ToolEnvelope> {
  try {
    return await runTool(request.tool as MCPToolName, request.args as any);
  } catch (error: any) {
    if (error instanceof ToolExecutionError) {
      return fail(error);
    }

    return {
      ok: false,
      sceneRevision: runtimeState.sceneRevision,
      error: {
        code: 'INTERNAL_ERROR',
        message: error?.message || 'Unknown tool execution error',
        recoverable: true,
        detail: error,
        suggestedToolCalls: [],
      },
      warnings: [],
    };
  }
}

if (import.meta.env.DEV) {
  (window as any).__executeMcpTool = executeMcpToolRequest;
}
