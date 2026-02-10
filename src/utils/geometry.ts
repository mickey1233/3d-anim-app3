/**
 * Geometry Engine — Face frames, mate solving, twist computation.
 *
 * All functions operate on Three.js objects and return serialisable results
 * compatible with the shared/types.ts schemas so they can be sent over
 * WebSocket to the MCP server.
 */

import * as THREE from 'three';
import { computeSmartOBB } from './OBBUtils';
import type { Vec3, Quat, FaceDirection, FaceFrame, MateMode, PathKeyframe } from '../../shared/types';
import { generateArcPath } from './pathgen';

// ============================================================
// HELPERS
// ============================================================

/** Convert THREE.Vector3 → Vec3 tuple */
const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/** Convert THREE.Quaternion → Quat tuple */
const q4 = (q: THREE.Quaternion): Quat => [q.x, q.y, q.z, q.w];

/** Build THREE.Vector3 from Vec3 */
const toV3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Build THREE.Quaternion from Quat */
const toQ4 = (a: Quat) => new THREE.Quaternion(a[0], a[1], a[2], a[3]);

/**
 * Pick the world axis most perpendicular to `axis`.
 * Used as a stable reference direction for twist auto-alignment.
 */
function bestWorldRef(axis: THREE.Vector3): THREE.Vector3 {
  const candidates = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  let best = candidates[0];
  let minDot = Infinity;
  for (const c of candidates) {
    const d = Math.abs(axis.dot(c));
    if (d < minDot) {
      minDot = d;
      best = c;
    }
  }
  return best.clone().projectOnPlane(axis).normalize();
}

// ============================================================
// 1. FACE FRAME
// ============================================================

export interface FaceFrameResult {
  frame: FaceFrame;
  bounds: { width: number; height: number };
}

/**
 * Compute the coordinate frame for a semantic face on a mesh.
 *
 * Uses the OBB (oriented bounding box) to determine face axes.
 * Returns origin / normal / tangent / bitangent in **world space**.
 */
export function computeFaceFrame(
  mesh: THREE.Mesh,
  face: FaceDirection,
): FaceFrameResult {
  mesh.updateWorldMatrix(true, false);

  const { center, size, basis } = computeSmartOBB(mesh);
  const halfSize = size.clone().multiplyScalar(0.5);

  // Extract OBB local axes from basis matrix columns
  const axisX = new THREE.Vector3().setFromMatrixColumn(basis, 0).normalize();
  const axisY = new THREE.Vector3().setFromMatrixColumn(basis, 1).normalize();
  const axisZ = new THREE.Vector3().setFromMatrixColumn(basis, 2).normalize();

  let normal: THREE.Vector3;
  let tangent: THREE.Vector3;
  let bitangent: THREE.Vector3;
  let faceCenter: THREE.Vector3;
  let faceWidth: number;
  let faceHeight: number;

  switch (face) {
    case 'top':
      normal    = axisY.clone();
      tangent   = axisX.clone();
      bitangent = axisZ.clone();
      faceCenter = center.clone().addScaledVector(axisY, halfSize.y);
      faceWidth  = size.x;
      faceHeight = size.z;
      break;
    case 'bottom':
      normal    = axisY.clone().negate();
      tangent   = axisX.clone();
      bitangent = axisZ.clone().negate();
      faceCenter = center.clone().addScaledVector(axisY, -halfSize.y);
      faceWidth  = size.x;
      faceHeight = size.z;
      break;
    case 'right':
      normal    = axisX.clone();
      tangent   = axisZ.clone().negate();
      bitangent = axisY.clone();
      faceCenter = center.clone().addScaledVector(axisX, halfSize.x);
      faceWidth  = size.z;
      faceHeight = size.y;
      break;
    case 'left':
      normal    = axisX.clone().negate();
      tangent   = axisZ.clone();
      bitangent = axisY.clone();
      faceCenter = center.clone().addScaledVector(axisX, -halfSize.x);
      faceWidth  = size.z;
      faceHeight = size.y;
      break;
    case 'front':
      normal    = axisZ.clone();
      tangent   = axisX.clone();
      bitangent = axisY.clone();
      faceCenter = center.clone().addScaledVector(axisZ, halfSize.z);
      faceWidth  = size.x;
      faceHeight = size.y;
      break;
    case 'back':
      normal    = axisZ.clone().negate();
      tangent   = axisX.clone().negate();
      bitangent = axisY.clone();
      faceCenter = center.clone().addScaledVector(axisZ, -halfSize.z);
      faceWidth  = size.x;
      faceHeight = size.y;
      break;
    case 'center':
    default:
      normal    = axisY.clone();
      tangent   = axisX.clone();
      bitangent = axisZ.clone();
      faceCenter = center.clone();
      faceWidth  = size.x;
      faceHeight = size.z;
      break;
  }

  // Transform local → world via mesh.matrixWorld
  const worldOrigin = faceCenter.clone().applyMatrix4(mesh.matrixWorld);

  const normalMat = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const worldNormal    = normal.clone().applyMatrix3(normalMat).normalize();
  const worldTangent   = tangent.clone().applyMatrix3(normalMat).normalize();
  const worldBitangent = bitangent.clone().applyMatrix3(normalMat).normalize();

  return {
    frame: {
      origin:    v3(worldOrigin),
      normal:    v3(worldNormal),
      tangent:   v3(worldTangent),
      bitangent: v3(worldBitangent),
    },
    bounds: { width: faceWidth, height: faceHeight },
  };
}

// ============================================================
// 2. FLUSH MATE
// ============================================================

export interface MateResult {
  position: Vec3;
  quaternion: Quat;
  debug: {
    source_frame: FaceFrame;
    target_frame: FaceFrame;
    rotation_axis: Vec3;
    rotation_angle_deg: number;
    translation_vector: Vec3;
    flip_applied: boolean;
    twist_applied_deg: number;
    normal_dot: number;
  };
}

/**
 * Compute the transform that mates `sourceMesh`'s face to `targetMesh`'s face
 * so that the source face normal **opposes** the target face normal and the
 * face centres coincide (with optional offset along normal).
 *
 * The returned position/quaternion are in **world space** and should be applied
 * to the source mesh's *world* transform (or converted to local if parented).
 *
 * @param flip   If true, the source normal is reversed before alignment.
 *               This lets you mate top→top by flipping the source 180°.
 * @param twistAngle  Additional rotation (degrees) around the aligned normal
 *                    after the primary alignment rotation.
 */
export function computeFlushMate(
  sourceMesh: THREE.Mesh,
  sourceFace: FaceDirection,
  targetMesh: THREE.Mesh,
  targetFace: FaceDirection,
  offset: number = 0,
  flip: boolean = false,
  twistAngle: number = 0,
): MateResult {
  const srcResult = computeFaceFrame(sourceMesh, sourceFace);
  const tgtResult = computeFaceFrame(targetMesh, targetFace);

  const srcFrame = srcResult.frame;
  const tgtFrame = tgtResult.frame;

  let srcN = toV3(srcFrame.normal);
  const tgtN = toV3(tgtFrame.normal);

  // Flip source normal if requested
  if (flip) {
    srcN.negate();
  }

  // Check normal alignment
  const normalDot = srcN.dot(tgtN);

  // ── Step 1: Rotation to oppose normals ──
  // We want R * srcN = -tgtN  (normals face each other)
  const targetDir = tgtN.clone().negate();
  const qAlign = new THREE.Quaternion().setFromUnitVectors(srcN, targetDir);

  // ── Step 2: Apply twist ──
  let finalQ = qAlign.clone();
  if (twistAngle !== 0) {
    const twistAxis = targetDir.clone(); // Twist around the aligned normal
    const qTwist = new THREE.Quaternion().setFromAxisAngle(
      twistAxis,
      THREE.MathUtils.degToRad(twistAngle),
    );
    finalQ.premultiply(qTwist);
  }

  // ── Step 3: Compute new world position ──
  // After rotation, the source face origin moves. We need to find where
  // the source face centre ends up and translate so it lands on the target.
  //
  // Current source mesh world position
  const srcMeshWorldPos = new THREE.Vector3();
  sourceMesh.getWorldPosition(srcMeshWorldPos);

  // Vector from mesh world pos to face origin (before rotation)
  const srcFaceOrigin = toV3(srcFrame.origin);
  const meshToFace = srcFaceOrigin.clone().sub(srcMeshWorldPos);

  // After rotation this vector becomes:
  const rotatedMeshToFace = meshToFace.clone().applyQuaternion(finalQ);

  // Target face origin + offset along target normal
  const tgtOrigin = toV3(tgtFrame.origin);
  const offsetVec = tgtN.clone().multiplyScalar(offset);
  const targetPoint = tgtOrigin.clone().add(offsetVec);

  // New mesh world position = targetPoint - rotatedMeshToFace
  const newWorldPos = targetPoint.clone().sub(rotatedMeshToFace);

  // ── Step 4: Combine rotation with source mesh's current world rotation ──
  const srcWorldQuat = new THREE.Quaternion();
  sourceMesh.getWorldQuaternion(srcWorldQuat);
  const resultQuat = finalQ.clone().multiply(srcWorldQuat);

  // Debug: extract rotation axis/angle from the alignment quaternion
  const rotAngle = 2 * Math.acos(Math.min(1, Math.abs(finalQ.w)));
  const sinHalf = Math.sin(rotAngle / 2);
  const rotAxis = sinHalf > 1e-6
    ? new THREE.Vector3(finalQ.x / sinHalf, finalQ.y / sinHalf, finalQ.z / sinHalf)
    : new THREE.Vector3(0, 1, 0);

  return {
    position: v3(newWorldPos),
    quaternion: q4(resultQuat),
    debug: {
      source_frame: srcFrame,
      target_frame: tgtFrame,
      rotation_axis: v3(rotAxis),
      rotation_angle_deg: THREE.MathUtils.radToDeg(rotAngle),
      translation_vector: v3(newWorldPos.clone().sub(srcMeshWorldPos)),
      flip_applied: flip,
      twist_applied_deg: twistAngle,
      normal_dot: normalDot,
    },
  };
}

// ============================================================
// 3. INSERT MATE (flush + arc path)
// ============================================================

/**
 * Same alignment as flush mate, but also generates an arc path
 * for the "both" / "insert" / "cover" animation.
 */
export function computeInsertMate(
  sourceMesh: THREE.Mesh,
  sourceFace: FaceDirection,
  targetMesh: THREE.Mesh,
  targetFace: FaceDirection,
  offset: number = 0,
  flip: boolean = false,
  twistAngle: number = 0,
  pathSteps: number = 20,
): MateResult & { path: PathKeyframe[] } {
  // Compute final pose (same as flush)
  const mate = computeFlushMate(
    sourceMesh, sourceFace, targetMesh, targetFace, offset, flip, twistAngle,
  );

  // Current world pose of source mesh
  const startPos = new THREE.Vector3();
  sourceMesh.getWorldPosition(startPos);
  const startQuat = new THREE.Quaternion();
  sourceMesh.getWorldQuaternion(startQuat);

  const endPos = toV3(mate.position);
  const endQuat = toQ4(mate.quaternion);

  // Generate arc path
  const path = generateArcPath(startPos, startQuat, endPos, endQuat, 0, pathSteps);

  return { ...mate, path };
}

// ============================================================
// 4. GENERIC MATE DISPATCHER
// ============================================================

export interface FullMateResult extends MateResult {
  path?: PathKeyframe[];
}

/**
 * Compute the transform for any mate mode.
 * Returns the target transform and, for `insert` mode, an arc path.
 */
export function computeMate(
  sourceMesh: THREE.Mesh,
  sourceFace: FaceDirection,
  targetMesh: THREE.Mesh,
  targetFace: FaceDirection,
  mode: MateMode,
  offset: number = 0,
  flip: boolean = false,
  twistAngle: number = 0,
): FullMateResult {
  // Validate: same part?
  if (sourceMesh.uuid === targetMesh.uuid) {
    throw Object.assign(
      new Error('Cannot mate a part to itself.'),
      { code: 'SAME_PART' },
    );
  }

  switch (mode) {
    case 'flush':
    case 'edge_to_edge':
    case 'axis_to_axis':
    case 'planar_slide': {
      // All use the flush alignment as baseline.
      // Specialised edge/axis/planar solving can be layered on later.
      const result = computeFlushMate(
        sourceMesh, sourceFace, targetMesh, targetFace, offset, flip, twistAngle,
      );

      // Auto-flip detection
      if (!flip && result.debug.normal_dot > 0.9) {
        throw Object.assign(
          new Error(
            'Source and target normals point in the same direction. ' +
            'Flush mate requires opposing normals. Retry with flip=true.',
          ),
          { code: 'NORMALS_SAME_DIRECTION' },
        );
      }

      return result;
    }

    case 'insert': {
      const result = computeInsertMate(
        sourceMesh, sourceFace, targetMesh, targetFace, offset, flip, twistAngle,
      );

      // Auto-flip detection
      if (!flip && result.debug.normal_dot > 0.9) {
        throw Object.assign(
          new Error(
            'Source and target normals point in the same direction. Retry with flip=true.',
          ),
          { code: 'NORMALS_SAME_DIRECTION' },
        );
      }

      return result;
    }

    case 'point_to_point': {
      // Translation only — move source face center to target face center
      const srcResult = computeFaceFrame(sourceMesh, sourceFace);
      const tgtResult = computeFaceFrame(targetMesh, targetFace);

      const srcOrigin = toV3(srcResult.frame.origin);
      const tgtOrigin = toV3(tgtResult.frame.origin);

      const srcWorldPos = new THREE.Vector3();
      sourceMesh.getWorldPosition(srcWorldPos);
      const srcWorldQuat = new THREE.Quaternion();
      sourceMesh.getWorldQuaternion(srcWorldQuat);

      const meshToFace = srcOrigin.clone().sub(srcWorldPos);
      const newWorldPos = tgtOrigin.clone().sub(meshToFace);

      return {
        position: v3(newWorldPos),
        quaternion: q4(srcWorldQuat), // Keep original rotation
        debug: {
          source_frame: srcResult.frame,
          target_frame: tgtResult.frame,
          rotation_axis: [0, 1, 0],
          rotation_angle_deg: 0,
          translation_vector: v3(newWorldPos.clone().sub(srcWorldPos)),
          flip_applied: false,
          twist_applied_deg: 0,
          normal_dot: toV3(srcResult.frame.normal).dot(toV3(tgtResult.frame.normal)),
        },
      };
    }

    default:
      throw new Error(`Unsupported mate mode: ${mode}`);
  }
}

// ============================================================
// 5. TWIST
// ============================================================

export interface TwistResult {
  quaternion: Quat;
  computedAxis: Vec3;
  computedAngleDeg: number;
  snappedAngleDeg?: number;
  debug: {
    original_rotation: Vec3;
    pivot_point: Vec3;
    axis_source: string;
  };
}

/**
 * Compute a rotation (twist) for a mesh around a given or auto-inferred axis.
 *
 * @param mesh           The mesh to twist
 * @param axis           Rotation axis: 'x'|'y'|'z'|'face_normal'|[nx,ny,nz]
 * @param angleDeg       Angle in degrees. If undefined, auto-aligns to nearest world ref.
 * @param referenceFace  Required when axis='face_normal', or for auto-alignment.
 * @param snapIncrement  Snap to nearest N degrees. 0 = no snap.
 */
export function computeTwist(
  mesh: THREE.Mesh,
  axis?: 'x' | 'y' | 'z' | 'face_normal' | Vec3,
  angleDeg?: number,
  referenceFace?: FaceDirection,
  snapIncrement: number = 0,
): TwistResult {
  mesh.updateWorldMatrix(true, false);

  // ── Resolve axis ──
  let twistAxis: THREE.Vector3;
  let axisSource: string;

  if (axis === undefined || axis === null) {
    twistAxis = new THREE.Vector3(0, 1, 0);
    axisSource = 'default_y';
  } else if (axis === 'x') {
    twistAxis = new THREE.Vector3(1, 0, 0);
    axisSource = 'world_x';
  } else if (axis === 'y') {
    twistAxis = new THREE.Vector3(0, 1, 0);
    axisSource = 'world_y';
  } else if (axis === 'z') {
    twistAxis = new THREE.Vector3(0, 0, 1);
    axisSource = 'world_z';
  } else if (axis === 'face_normal') {
    if (!referenceFace) {
      throw Object.assign(
        new Error("axis='face_normal' requires referenceFace parameter."),
        { code: 'INVALID_AXIS' },
      );
    }
    const faceResult = computeFaceFrame(mesh, referenceFace);
    twistAxis = toV3(faceResult.frame.normal);
    axisSource = `face_normal_${referenceFace}`;
  } else if (Array.isArray(axis)) {
    twistAxis = new THREE.Vector3(axis[0], axis[1], axis[2]);
    if (twistAxis.length() < 1e-6) {
      throw Object.assign(
        new Error('Twist axis is zero-length.'),
        { code: 'INVALID_AXIS' },
      );
    }
    twistAxis.normalize();
    axisSource = 'custom';
  } else {
    twistAxis = new THREE.Vector3(0, 1, 0);
    axisSource = 'fallback_y';
  }

  // ── Determine angle ──
  let angle: number;
  if (angleDeg !== undefined) {
    angle = angleDeg;
  } else {
    // Auto-align: find smallest rotation around twistAxis that aligns
    // mesh's current forward direction to a stable world reference.
    const currentQuat = new THREE.Quaternion();
    mesh.getWorldQuaternion(currentQuat);
    const currentForward = new THREE.Vector3(0, 0, 1).applyQuaternion(currentQuat);
    const projected = currentForward.clone().projectOnPlane(twistAxis).normalize();
    const worldRef = bestWorldRef(twistAxis);

    if (projected.length() < 1e-6) {
      // Forward is parallel to twist axis — no meaningful auto-alignment
      angle = 0;
    } else {
      // Signed angle from projected to worldRef around twistAxis
      angle = THREE.MathUtils.radToDeg(
        Math.atan2(
          projected.clone().cross(worldRef).dot(twistAxis),
          projected.dot(worldRef),
        ),
      );
      angle = -angle; // Negate: rotate TO the reference, not away
    }
  }

  // ── Snap ──
  let snapped: number | undefined;
  if (snapIncrement > 0) {
    snapped = Math.round(angle / snapIncrement) * snapIncrement;
    angle = snapped;
  }

  // ── Build result quaternion ──
  const qTwist = new THREE.Quaternion().setFromAxisAngle(
    twistAxis,
    THREE.MathUtils.degToRad(angle),
  );

  const currentWorldQuat = new THREE.Quaternion();
  mesh.getWorldQuaternion(currentWorldQuat);
  const resultQuat = qTwist.clone().multiply(currentWorldQuat);

  // Pivot point = mesh world position (rotate in place)
  const pivot = new THREE.Vector3();
  mesh.getWorldPosition(pivot);

  const currentEuler = new THREE.Euler().setFromQuaternion(currentWorldQuat);

  return {
    quaternion: q4(resultQuat),
    computedAxis: v3(twistAxis),
    computedAngleDeg: angle,
    snappedAngleDeg: snapped,
    debug: {
      original_rotation: [currentEuler.x, currentEuler.y, currentEuler.z],
      pivot_point: v3(pivot),
      axis_source: axisSource,
    },
  };
}

// ============================================================
// 6. TRANSFORM HELPERS (world ↔ local conversion)
// ============================================================

/**
 * Convert a world-space position + quaternion to a mesh's local parent space.
 * Use this before applying the result to mesh.position / mesh.quaternion.
 */
export function worldToLocal(
  mesh: THREE.Object3D,
  worldPos: Vec3,
  worldQuat: Quat,
): { localPosition: Vec3; localRotation: Vec3 } {
  const parent = mesh.parent;

  const wp = toV3(worldPos);
  const wq = toQ4(worldQuat);

  if (parent) {
    parent.updateWorldMatrix(true, false);
    const parentInv = parent.matrixWorld.clone().invert();

    // Position: transform to parent local
    const lp = wp.clone().applyMatrix4(parentInv);

    // Rotation: remove parent world rotation
    const parentWorldQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuat);
    const localQuat = parentWorldQuat.clone().invert().multiply(wq);
    const euler = new THREE.Euler().setFromQuaternion(localQuat);

    return {
      localPosition: v3(lp),
      localRotation: [euler.x, euler.y, euler.z],
    };
  }

  // No parent — world = local
  const euler = new THREE.Euler().setFromQuaternion(wq);
  return {
    localPosition: v3(wp),
    localRotation: [euler.x, euler.y, euler.z],
  };
}

/**
 * Resolve a part name to a mesh in the scene graph via fuzzy matching.
 */
export function findMeshByName(
  scene: THREE.Object3D,
  nameOrUuid: string,
): THREE.Mesh | null {
  let exact: THREE.Mesh | null = null;
  let bestFuzzy: THREE.Mesh | null = null;
  let bestDist = Infinity;

  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;

    // Exact UUID match
    if (mesh.uuid === nameOrUuid) {
      exact = mesh;
      return;
    }

    // Exact name match (case-insensitive)
    if (mesh.name.toLowerCase() === nameOrUuid.toLowerCase()) {
      exact = mesh;
      return;
    }

    // Simple fuzzy: Levenshtein-ish comparison (substring match first)
    const meshLower = mesh.name.toLowerCase();
    const queryLower = nameOrUuid.toLowerCase();

    if (meshLower.includes(queryLower) || queryLower.includes(meshLower)) {
      const dist = Math.abs(meshLower.length - queryLower.length);
      if (dist < bestDist) {
        bestDist = dist;
        bestFuzzy = mesh;
      }
    }
  });

  return exact || bestFuzzy;
}
