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
import { resolveAnchor } from '../three/mating/anchorMethods';
import { solveMateTopBottom } from '../three/mating/solver';

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
type MateIntentKind = 'default' | 'cover' | 'insert';

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

function instructionIncludesAny(instruction: string, tokens: string[]) {
  return tokens.some((token) => instruction.includes(token));
}

function inferMateIntentKind(instruction: string): MateIntentKind {
  if (
    instructionIncludesAny(instruction, [
      'slot',
      'insert',
      'plug',
      'socket',
      'into',
      '插槽',
      '插入',
      '塞進',
      '塞进',
      '卡入',
    ])
  ) {
    return 'insert';
  }
  if (
    instructionIncludesAny(instruction, [
      'cover',
      'lid',
      'cap',
      'close',
      '蓋',
      '盖',
      '合上',
      '蓋上',
      '盖上',
    ])
  ) {
    return 'cover';
  }
  return 'default';
}

function inferModeFromInstruction(instruction: string): MateExecMode | null {
  const hasTwist = instructionIncludesAny(instruction, ['twist', 'rotate', 'spin', '旋轉', '旋转', '轉動', '转动']);
  const hasArc = instructionIncludesAny(instruction, ['arc', 'cover', 'lid', 'cap', 'insert', 'slot', '蓋', '盖', '插入', '插槽']);
  if (hasTwist && hasArc) return 'both';
  if (hasArc) return 'both';
  if (hasTwist) return 'twist';
  return null;
}

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

function inferIntentFromGeometry(sourceObject: THREE.Object3D, targetObject: THREE.Object3D): MateIntentKind | null {
  const sourceBox = new THREE.Box3().setFromObject(sourceObject);
  const targetBox = new THREE.Box3().setFromObject(targetObject);
  if (sourceBox.isEmpty() || targetBox.isEmpty()) return null;

  const sourceCenter = sourceBox.getCenter(new THREE.Vector3());
  const targetCenter = targetBox.getCenter(new THREE.Vector3());
  const sourceSize = sourceBox.getSize(new THREE.Vector3());
  const targetSize = targetBox.getSize(new THREE.Vector3());
  const delta = targetCenter.clone().sub(sourceCenter);

  const overlapX = overlapRatio1D(sourceBox.min.x, sourceBox.max.x, targetBox.min.x, targetBox.max.x);
  const overlapY = overlapRatio1D(sourceBox.min.y, sourceBox.max.y, targetBox.min.y, targetBox.max.y);
  const overlapZ = overlapRatio1D(sourceBox.min.z, sourceBox.max.z, targetBox.min.z, targetBox.max.z);

  const sourceFitsWithinTargetXY = sourceSize.x <= targetSize.x * 0.94 && sourceSize.z <= targetSize.z * 0.94;
  const sourceFitsWithinTargetXZ = sourceSize.x <= targetSize.x * 0.94 && sourceSize.y <= targetSize.y * 0.94;
  const sourceFitsWithinTargetYZ = sourceSize.y <= targetSize.y * 0.94 && sourceSize.z <= targetSize.z * 0.94;

  if ((sourceFitsWithinTargetXY && overlapX > 0.45 && overlapZ > 0.45) ||
      (sourceFitsWithinTargetXZ && overlapX > 0.45 && overlapY > 0.45) ||
      (sourceFitsWithinTargetYZ && overlapY > 0.45 && overlapZ > 0.45)) {
    return 'insert';
  }

  const stackedAlongY = Math.abs(delta.y) > (sourceSize.y + targetSize.y) * 0.22 && overlapX > 0.5 && overlapZ > 0.5;
  if (stackedAlongY) return 'cover';

  return null;
}

function defaultModeForIntent(intent: MateIntentKind): MateExecMode {
  // 'cover' geometry (lid-on-body) → 'both' for direct tool calls / query.mate_suggestions.
  // When routed through chat, mockProvider filters this down to 'translate' for generic
  // "assemble" commands that don't include explicit insert/cover/arc keywords.
  if (intent === 'cover') return 'both';
  return 'translate';
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

function buildMethodPriority(params: {
  explicit?: AnchorMethodId | null;
  instructionMethod?: AnchorMethodId | null;
  intent: MateIntentKind;
  role: 'source' | 'target';
}): AnchorMethodId[] {
  const { explicit, instructionMethod, intent, role } = params;
  if (explicit) return [explicit];
  if (instructionMethod && instructionMethod !== 'auto') {
    return [instructionMethod, 'planar_cluster', 'geometry_aabb', 'object_aabb'];
  }

  if (intent === 'insert') {
    return role === 'source'
      ? ['extreme_vertices', 'planar_cluster', 'geometry_aabb', 'object_aabb', 'auto']
      : ['planar_cluster', 'extreme_vertices', 'geometry_aabb', 'object_aabb', 'auto'];
  }

  if (intent === 'cover') {
    return ['auto', 'planar_cluster', 'geometry_aabb', 'object_aabb', 'extreme_vertices'];
  }

  return ['auto', 'planar_cluster', 'geometry_aabb', 'object_aabb', 'extreme_vertices'];
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
}): FacePairSuggestion | null {
  const {
    sourceObject,
    targetObject,
    sourceMethods,
    targetMethods,
    preferredSourceFace,
    preferredTargetFace,
    limit,
  } = params;

  const sourceCenter = new THREE.Box3().setFromObject(sourceObject).getCenter(new THREE.Vector3());
  const targetCenter = new THREE.Box3().setFromObject(targetObject).getCenter(new THREE.Vector3());
  const sourceToTarget = targetCenter.clone().sub(sourceCenter);
  const sourceToTargetDir = normalize(sourceToTarget, new THREE.Vector3(0, 1, 0));
  const expectedFaces = getExpectedFacePairFromCenters(sourceCenter, targetCenter);

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
      const score =
        facingScore * 0.46 +
        approachScore * 0.26 +
        distanceScore * 0.22 +
        expectedFaceScore * 0.02 +
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

function computeCaptureSize(params: {
  viewportWidth: number;
  viewportHeight: number;
  maxWidthPx: number;
  maxHeightPx: number;
}) {
  const { viewportWidth, viewportHeight, maxWidthPx, maxHeightPx } = params;
  const safeW = Math.max(1, viewportWidth);
  const safeH = Math.max(1, viewportHeight);
  const scale = Math.min(maxWidthPx / safeW, maxHeightPx / safeH, 1);
  return {
    width: clampInt(safeW * scale, 64, 2048),
    height: clampInt(safeH * scale, 64, 2048),
  };
}

function dataUrlFromPixels(params: { pixels: Uint8Array; width: number; height: number; mimeType: string; jpegQuality?: number }) {
  const { pixels, width, height, mimeType, jpegQuality } = params;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not available');

  const imageData = ctx.createImageData(width, height);
  const rowStride = width * 4;
  // Flip Y: WebGL readPixels origin is bottom-left.
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowStride;
    const dstRow = y * rowStride;
    imageData.data.set(pixels.subarray(srcRow, srcRow + rowStride), dstRow);
  }
  ctx.putImageData(imageData, 0, 0);

  if (mimeType === 'image/jpeg') {
    return canvas.toDataURL(mimeType, jpegQuality ?? 0.92);
  }
  return canvas.toDataURL(mimeType);
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

  const query = part.partName.trim().toLowerCase();
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
    const methodRequested = feature.method ?? 'auto';
    const methodUsed = methodRequested === 'auto' ? 'geometry_aabb' : methodRequested;
    return {
      kind: 'face',
      part,
      face: feature.face,
      methodRequested,
      methodUsed,
      fallbackUsed: methodRequested === 'picked' && methodUsed !== 'picked',
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
    const methodRequested = (args as any).method ?? 'auto';
    const object = getObjectByPartIdOrThrow(part.partId);
    const primary = resolveAnchor({ object, faceId: face, method: methodRequested });
    const fallback =
      primary ??
      (methodRequested === 'geometry_aabb' ? null : resolveAnchor({ object, faceId: face, method: 'geometry_aabb' })) ??
      (methodRequested === 'object_aabb' ? null : resolveAnchor({ object, faceId: face, method: 'object_aabb' }));
    const anchor = primary ?? fallback;
    const methodUsed =
      anchor?.method ?? (methodRequested === 'auto' ? 'geometry_aabb' : methodRequested);
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
    const instructionIntent = inferMateIntentKind(instruction);

    const sourceObject = getObjectByPartIdOrThrow(source.partId);
    const targetObject = getObjectByPartIdOrThrow(target.partId);

    const sourceBoxWorld = worldBoundingBoxFromObject(sourceObject);
    const targetBoxWorld = worldBoundingBoxFromObject(targetObject);

    const sourceCenter = vec3(sourceBoxWorld.center);
    const targetCenter = vec3(targetBoxWorld.center);
    const expectedFromCenters = getExpectedFacePairFromCenters(sourceCenter, targetCenter);

    const geometryIntent = inferIntentFromGeometry(sourceObject, targetObject);
    const intentKind = instructionIntent === 'default' ? geometryIntent ?? 'default' : instructionIntent;
    const suggestedMode =
      inferModeFromInstruction(instruction) ?? defaultModeForIntent(intentKind);

    const instructionMethod = methodFromInstruction(instruction);
    const explicitSourceMethod =
      typeof input.sourceMethod === 'string' && input.sourceMethod !== 'auto'
        ? (input.sourceMethod as AnchorMethodId)
        : null;
    const explicitTargetMethod =
      typeof input.targetMethod === 'string' && input.targetMethod !== 'auto'
        ? (input.targetMethod as AnchorMethodId)
        : null;

    const sourceMethods = buildMethodPriority({
      explicit: explicitSourceMethod,
      instructionMethod,
      intent: intentKind,
      role: 'source',
    });
    const targetMethods = buildMethodPriority({
      explicit: explicitTargetMethod,
      instructionMethod,
      intent: intentKind,
      role: 'target',
    });

    const preferredSourceFace =
      STORE_FACES.includes(input.preferredSourceFace as StoreFaceId)
        ? (input.preferredSourceFace as StoreFaceId)
        : null;
    const preferredTargetFace =
      STORE_FACES.includes(input.preferredTargetFace as StoreFaceId)
        ? (input.preferredTargetFace as StoreFaceId)
        : null;
    const maxPairs = Number(input.maxPairs ?? 12);

    const suggestion = inferBestFacePair({
      sourceObject,
      targetObject,
      sourceMethods,
      targetMethods,
      preferredSourceFace,
      preferredTargetFace,
      limit: Number.isFinite(maxPairs) ? Math.max(1, Math.min(36, Math.floor(maxPairs))) : 12,
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
            'Mate suggestions computed from live scene geometry',
            `intent=${intentKind}`,
            `geometry_intent=${geometryIntent ?? 'none'}`,
            `instruction_method=${instructionMethod ?? 'none'}`,
          ],
        },
      }
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
    store.clearAllPartOverrides();
    clearPreviewState();
    runtimeState.previewBeforeTransformByPartId.clear();
    return ok({ resetCount }, { mutating: resetCount > 0 });
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
        const sourceMethod = source.kind === 'face' ? source.methodRequested ?? source.methodUsed ?? 'auto' : 'auto';
        const targetMethod = target.kind === 'face' ? target.methodRequested ?? target.methodUsed ?? 'auto' : 'auto';
        const sourceOffset = parseOffsetTuple(input.sourceOffset);
        const targetOffset = parseOffsetTuple(input.targetOffset);

        if (sourceObj && targetObj && sourceFaceId && targetFaceId) {
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
      const sourceWorldPos = sourceObj ? new THREE.Vector3() : null;
      const sourceWorldQuat = sourceObj ? new THREE.Quaternion() : null;
      if (sourceObj && sourceWorldPos && sourceWorldQuat) {
        sourceObj.updateWorldMatrix(true, false);
        sourceObj.getWorldPosition(sourceWorldPos);
        sourceObj.getWorldQuaternion(sourceWorldQuat);
      }

      const sourceWorldTransform: PartTransform =
        sourceObj && sourceWorldPos && sourceWorldQuat
          ? {
              position: tuple3(sourceWorldPos),
              quaternion: tuple4(sourceWorldQuat),
              scale: [...sourceTransform.scale],
            }
          : sourceTransform;

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
      const endWorldTransform: PartTransform = {
        position: [...solved.endTransform.position],
        quaternion: [...solved.endTransform.quaternion],
        scale: [...sourceTransform.scale],
      };

      if (operation === 'twist') {
        endWorldTransform.position = [...sourceWorldTransform.position];
      }

      pathType =
        input.pathPreference === 'arc' ||
        input.pathPreference === 'screw' ||
        (input.pathPreference === 'auto' && (operation === 'both' || input.mateMode === 'face_insert_arc'))
          ? input.pathPreference === 'screw'
            ? 'screw'
            : 'arc'
          : 'line';

      debugNotes.push('Alignment solved from source/target feature frames');
      if (operation === 'twist') debugNotes.push('Twist mode keeps part position fixed');

      const durationMs = Number(input.durationMs ?? 900);
      const sampleCount = Number(input.sampleCount ?? 60);
      const arcHeight = Number(input.arc?.height ?? 0);
      const stepsWorld = samplePath({
        start: sourceWorldTransform,
        end: endWorldTransform,
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
      endTransform =
        sourceObj && sourceWorldPos && sourceWorldQuat
          ? {
              ...sourceTransform,
              ...worldPoseToLocalPose(sourceObj, vec3(endWorldTransform.position), quat4(endWorldTransform.quaternion).normalize()),
            }
          : endWorldTransform;

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
          rotationAxisWorld: solved.debug.rotationQuat,
          twistAxisWorld: solved.debug.twistAxisWorld,
          twistAngleDeg: solved.debug.twistAngleDeg,
          translationWorld: solved.debug.translationWorld,
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

    const generated = await runTool('action.generate_transform_plan' as MCPToolName, {
      operation,
      source: {
        kind: 'face',
        part: { partId: source.partId },
        face: input.sourceFace ?? 'bottom',
        method: input.sourceMethod ?? 'auto',
      },
      target: {
        kind: 'face',
        part: { partId: target.partId },
        face: input.targetFace ?? 'top',
        method: input.targetMethod ?? 'auto',
      },
      sourceOffset: input.sourceOffset,
      targetOffset: input.targetOffset,
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

    const committed = await runTool('action.commit_preview' as MCPToolName, {
      previewId: preview.previewId,
      pushHistory: input.pushHistory !== false,
      stepLabel:
        input.stepLabel ?? `Mate ${source.partName} to ${target.partName}`,
    } as any);
    const commitData = unwrapToolData(committed, 'PREVIEW_NOT_FOUND');

    return ok(
      {
        source,
        target,
        plan,
        preview,
        committed: true,
        historyId: commitData.historyId,
        transform: commitData.transform,
      },
      { mutating: false, debug: plan.debug }
    );
  }

  if (tool === 'action.smart_mate_execute') {
    const input = args as any;
    const source = resolvePart(input.sourcePart);
    const target = resolvePart(input.targetPart);
    const instruction = normalizeInstructionText(input.instruction);
    const instructionIntent = inferMateIntentKind(instruction);

    const explicitSourceFace =
      STORE_FACES.includes(input.sourceFace as StoreFaceId) ? (input.sourceFace as StoreFaceId) : null;
    const explicitTargetFace =
      STORE_FACES.includes(input.targetFace as StoreFaceId) ? (input.targetFace as StoreFaceId) : null;

    const explicitSourceMethod = (input.sourceMethod as AnchorMethodId | undefined) ?? null;
    const explicitTargetMethod = (input.targetMethod as AnchorMethodId | undefined) ?? null;
    const instructionMethod = methodFromInstruction(instruction);

    const sourceObject = getV2ObjectByPartId(source.partId);
    const targetObject = getV2ObjectByPartId(target.partId);
    const geometryIntent =
      sourceObject && targetObject ? inferIntentFromGeometry(sourceObject, targetObject) : null;
    const intentKind = instructionIntent === 'default' ? geometryIntent ?? 'default' : instructionIntent;

    const inferredMode = inferModeFromInstruction(instruction);
    const mode =
      (input.mode as MateExecMode | undefined) ??
      inferredMode ??
      defaultModeForIntent(intentKind);
    const operation = mode === 'both' ? 'both' : mode === 'twist' ? 'twist' : 'mate';
    const mateMode = input.mateMode ?? (mode === 'both' ? 'face_insert_arc' : 'face_flush');
    const pathPreferenceRaw = (input.pathPreference as 'auto' | 'line' | 'arc' | 'screw' | undefined) ?? 'auto';
    const pathPreference =
      pathPreferenceRaw === 'auto' ? (mode === 'both' ? 'arc' : 'line') : pathPreferenceRaw;

    const sourceMethodPriority = buildMethodPriority({
      explicit: explicitSourceMethod,
      instructionMethod,
      intent: intentKind,
      role: 'source',
    });
    const targetMethodPriority = buildMethodPriority({
      explicit: explicitTargetMethod,
      instructionMethod,
      intent: intentKind,
      role: 'target',
    });

    const suggestedFacePair =
      sourceObject && targetObject
        ? inferBestFacePair({
            sourceObject,
            targetObject,
            sourceMethods: sourceMethodPriority,
            targetMethods: targetMethodPriority,
            preferredSourceFace: explicitSourceFace,
            preferredTargetFace: explicitTargetFace,
          })
        : null;

    // Prefer geometry-based face pair over positional heuristic.
    // Fallback to 'bottom'/'top' rather than getExpectedFacePairFromCenters so that
    // moving a part laterally in the scene never silently flips the chosen faces.
    const chosenSourceFace = explicitSourceFace ?? suggestedFacePair?.sourceFace ?? 'bottom';
    const chosenTargetFace = explicitTargetFace ?? suggestedFacePair?.targetFace ?? 'top';
    const chosenSourceMethod = explicitSourceMethod ?? suggestedFacePair?.sourceMethod ?? sourceMethodPriority[0] ?? 'planar_cluster';
    const chosenTargetMethod = explicitTargetMethod ?? suggestedFacePair?.targetMethod ?? targetMethodPriority[0] ?? 'planar_cluster';

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
            'Smart mate executed with geometry-aware face/method/mode inference',
            `intent=${intentKind}`,
            `geometry_intent=${geometryIntent ?? 'none'}`,
            `instruction_method=${instructionMethod ?? 'none'}`,
          ],
          sourceFaceId: chosenSourceFace,
          targetFaceId: chosenTargetFace,
          sourceMethod: chosenSourceMethod,
          targetMethod: chosenTargetMethod,
          mode,
          pathType: pathPreference,
          inferenceScore: suggestedFacePair?.score,
          inferenceRanking: suggestedFacePair?.ranking ?? [],
          explicit: {
            sourceFace: explicitSourceFace,
            targetFace: explicitTargetFace,
            sourceMethod: explicitSourceMethod,
            targetMethod: explicitTargetMethod,
            mode: input.mode ?? null,
          },
        } as any,
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
    store.updateStepSnapshot(stepId);
    return ok({ updated: true, stepId }, { mutating: true });
  }

  if (tool === 'steps.playback_start') {
    const store = currentStore();
    const durationMs = (args as any).durationMs as number | undefined;
    if (store.playback.running) return ok({ running: true }, { mutating: false });
    store.startPlayback(durationMs ?? store.playback.durationMs);
    return ok({ running: true }, { mutating: true });
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
