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
    const methodUsed = methodRequested === 'auto' ? 'obb_pca' : methodRequested;
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
    const transform = getPartTransformOrThrow(feature.part.partId);
    return computeFaceFrame(transform, feature.face);
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
    const transform = getPartTransformOrThrow(part.partId);
    return ok({ part, boundingBox: buildBoundingBox(transform) }, { mutating: false });
  }

  if (tool === 'query.face_info') {
    const part = resolvePart((args as any).part);
    const face = (args as any).face;
    const transform = getPartTransformOrThrow(part.partId);
    const frame = computeFaceFrame(transform, face);
    const methodRequested = (args as any).method ?? 'auto';
    const methodUsed = methodRequested === 'auto' ? 'obb_pca' : methodRequested;
    return ok(
      {
        part,
        face,
        frameWorld: frame,
        normalOutward: true,
        methodRequested,
        methodUsed,
        fallbackUsed: false,
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

      const twistInput = input.twist ?? { angleDeg: 0, axis: 'normal', axisSpace: 'target_face' };
      const applyTwist = operation === 'both' || operation === 'twist' || Math.abs(Number(twistInput.angleDeg || 0)) > 1e-6;

      const solved = computeMateAlignedEndTransform({
        sourceTransform,
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
      endTransform = solved.endTransform;

      if (operation === 'twist') {
        endTransform.position = sourceTransform.position;
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
      const steps = samplePath({
        start: sourceTransform,
        end: endTransform,
        durationMs,
        sampleCount,
        pathType: pathType === 'screw' ? 'line' : pathType,
        arcHeight,
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
