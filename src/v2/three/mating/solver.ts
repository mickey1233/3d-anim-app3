import * as THREE from 'three';
import { clusterPlanarFaces, type FaceCluster } from './faceClustering';
import type { AnchorMethodId, FaceId, MateMode, TwistSpec } from '../../store/store';
import { resolveAnchor } from './anchorMethods';
import type { Anchor } from '../anchors/types';

export type MateTransform = {
  rotation: THREE.Quaternion;
  translation: THREE.Vector3;
  pivotWorld: THREE.Vector3;
  sourceFaceCenter: THREE.Vector3;
  targetFaceCenter: THREE.Vector3;
  sourceFaceLocal: THREE.Vector3;
  targetFaceLocal: THREE.Vector3;
  sourceNormalLocal: THREE.Vector3;
  targetNormalLocal: THREE.Vector3;
  normalRotation?: { axisWorld: THREE.Vector3; angleDeg: number };
  twistRotation?: { axisWorld: THREE.Vector3; angleDeg: number; source: 'spec' | 'tangent' };
  quality: {
    normalAlignment: number;
    planeDistance: number;
  };
};

type PlaneInputs = {
  sourceCenterWorld: THREE.Vector3;
  targetCenterWorld: THREE.Vector3;
  sourceNormalWorld: THREE.Vector3;
  targetNormalWorld: THREE.Vector3;
  sourceTangentWorld?: THREE.Vector3;
  targetTangentWorld?: THREE.Vector3;
  sourceFaceLocal: THREE.Vector3;
  targetFaceLocal: THREE.Vector3;
  sourceNormalLocal: THREE.Vector3;
  targetNormalLocal: THREE.Vector3;
};

export function getFaceByDirection(
  obj: THREE.Object3D,
  direction: THREE.Vector3
): FaceCluster | null {
  const mesh = obj as THREE.Mesh;
  if (!mesh.geometry) return null;
  const geom = mesh.geometry as THREE.BufferGeometry;
  const clusters: FaceCluster[] = clusterPlanarFaces(geom);

  const dir = direction.clone().normalize();
  let bestCluster: FaceCluster | null = null;
  let bestScore = -Infinity;
  let bestArea = -Infinity;

  clusters.forEach((cluster) => {
    const score = cluster.normal.dot(dir);
    if (score > bestScore + 0.01 || (Math.abs(score - bestScore) <= 0.01 && cluster.area > bestArea)) {
      bestCluster = cluster;
      bestScore = score;
      bestArea = cluster.area;
    }
  });

  if (!bestCluster || bestScore < 0.1) return null;
  return bestCluster;
}

export function solveMateTopBottom(
  source: THREE.Object3D,
  target: THREE.Object3D,
  sourceFace: FaceId,
  targetFace: FaceId,
  mode: MateMode,
  twistSpec?: TwistSpec,
  sourceMethod: AnchorMethodId = 'planar_cluster',
  targetMethod: AnchorMethodId = 'planar_cluster',
  sourcePick?: Anchor,
  targetPick?: Anchor,
  sourceOffset?: [number, number, number],
  targetOffset?: [number, number, number]
): MateTransform | null {
  const sourceFacePick = sourcePick?.type === 'face' ? sourcePick : undefined;
  const targetFacePick = targetPick?.type === 'face' ? targetPick : undefined;
  const sourceAnchor = resolveAnchor({
    object: source,
    faceId: sourceFace,
    method: sourceMethod,
    pick: sourceFacePick,
  });
  const targetAnchor = resolveAnchor({
    object: target,
    faceId: targetFace,
    method: targetMethod,
    pick: targetFacePick,
  });

  const sourceOffsetVec = new THREE.Vector3(
    ...(sourceOffset || [0, 0, 0])
  );
  const targetOffsetVec = new THREE.Vector3(
    ...(targetOffset || [0, 0, 0])
  );

  if (!sourceAnchor || !targetAnchor) {
    return solveMateWithAabb(
      source,
      target,
      sourceFace,
      targetFace,
      mode,
      twistSpec,
      sourceOffsetVec,
      targetOffsetVec
    );
  }

  // Convert to world space
  const sourceCenterLocal = sourceAnchor.centerLocal.clone().add(sourceOffsetVec);
  const targetCenterLocal = targetAnchor.centerLocal.clone().add(targetOffsetVec);
  const planeInputs: PlaneInputs = {
    sourceNormalWorld: sourceAnchor.normalLocal.clone().transformDirection(source.matrixWorld),
    targetNormalWorld: targetAnchor.normalLocal.clone().transformDirection(target.matrixWorld),
    sourceCenterWorld: sourceCenterLocal.clone().applyMatrix4(source.matrixWorld),
    targetCenterWorld: targetCenterLocal.clone().applyMatrix4(target.matrixWorld),
    sourceFaceLocal: sourceCenterLocal.clone(),
    targetFaceLocal: targetCenterLocal.clone(),
    sourceNormalLocal: sourceAnchor.normalLocal.clone(),
    targetNormalLocal: targetAnchor.normalLocal.clone(),
    sourceTangentWorld: sourceAnchor.tangentLocal.clone().transformDirection(source.matrixWorld),
    targetTangentWorld: targetAnchor.tangentLocal.clone().transformDirection(target.matrixWorld),
  };

  return buildMateTransform(source, planeInputs, mode, twistSpec);
}

function solveMateWithAabb(
  source: THREE.Object3D,
  target: THREE.Object3D,
  sourceFace: FaceId,
  targetFace: FaceId,
  mode: MateMode,
  twistSpec?: TwistSpec,
  sourceOffset?: THREE.Vector3,
  targetOffset?: THREE.Vector3
): MateTransform | null {
  const sourceBox = new THREE.Box3().setFromObject(source);
  const targetBox = new THREE.Box3().setFromObject(target);
  if (sourceBox.isEmpty() || targetBox.isEmpty()) return null;

  const sourceCenterWorld = sourceBox.getCenter(new THREE.Vector3());
  const targetCenterWorld = targetBox.getCenter(new THREE.Vector3());
  const sourceSize = sourceBox.getSize(new THREE.Vector3());
  const targetSize = targetBox.getSize(new THREE.Vector3());

  const sourceAxis = faceToAxis(sourceFace);
  const targetAxis = faceToAxis(targetFace);

  const sourceHalfOffset =
    sourceAxis.sign *
    (sourceAxis.axis === 'x' ? sourceSize.x : sourceAxis.axis === 'y' ? sourceSize.y : sourceSize.z) *
    0.5;
  const targetHalfOffset =
    targetAxis.sign *
    (targetAxis.axis === 'x' ? targetSize.x : targetAxis.axis === 'y' ? targetSize.y : targetSize.z) *
    0.5;

  const sourceFaceCenterWorld = sourceCenterWorld.clone().add(sourceAxis.vector.clone().multiplyScalar(sourceHalfOffset));
  const targetFaceCenterWorld = targetCenterWorld.clone().add(targetAxis.vector.clone().multiplyScalar(targetHalfOffset));

  const sourceNormalWorld = sourceAxis.vector.clone().multiplyScalar(sourceAxis.sign);
  const targetNormalWorld = targetAxis.vector.clone().multiplyScalar(targetAxis.sign);

  const sourceFaceLocal = source.worldToLocal(sourceFaceCenterWorld.clone());
  const targetFaceLocal = target.worldToLocal(targetFaceCenterWorld.clone());
  if (sourceOffset) sourceFaceLocal.add(sourceOffset);
  if (targetOffset) targetFaceLocal.add(targetOffset);
  const sourceFaceCenterAdjustedWorld = source.localToWorld(sourceFaceLocal.clone());
  const targetFaceCenterAdjustedWorld = target.localToWorld(targetFaceLocal.clone());
  const sourceNormalLocal = sourceNormalWorld
    .clone()
    .transformDirection(new THREE.Matrix4().copy(source.matrixWorld).invert())
    .normalize();
  const targetNormalLocal = targetNormalWorld
    .clone()
    .transformDirection(new THREE.Matrix4().copy(target.matrixWorld).invert())
    .normalize();

  return buildMateTransform(
    source,
    {
    sourceCenterWorld: sourceFaceCenterAdjustedWorld,
    targetCenterWorld: targetFaceCenterAdjustedWorld,
    sourceNormalWorld,
    targetNormalWorld,
    sourceFaceLocal,
    targetFaceLocal,
    sourceNormalLocal,
    targetNormalLocal,
    sourceTangentWorld: faceToTangent(sourceFace).transformDirection(source.matrixWorld),
    targetTangentWorld: faceToTangent(targetFace).transformDirection(target.matrixWorld),
    },
    mode,
    twistSpec
  );
}

export function applyMateTransform(obj: THREE.Object3D, transform: MateTransform) {
  // Apply world-space rotation, correctly accounting for any parent transform.
  // obj.applyQuaternion(q) does localQuat = q * localQuat, which equals
  // worldQuat = parentQuat * q * localQuat — NOT q * worldQuat when parent ≠ identity.
  // The correct local-space equivalent of a world-space rotation q is:
  //   localRot = parentQuat⁻¹ * q * parentQuat
  if (obj.parent) {
    const parentQuat = new THREE.Quaternion();
    obj.parent.getWorldQuaternion(parentQuat);
    const localRot = parentQuat.clone().invert()
      .multiply(transform.rotation)
      .multiply(parentQuat);
    obj.quaternion.premultiply(localRot);
    obj.updateMatrixWorld(true);

    const parentWorldInv = new THREE.Matrix4().copy(obj.parent.matrixWorld).invert();
    const worldPos = new THREE.Vector3();
    obj.getWorldPosition(worldPos);
    worldPos.add(transform.translation);
    worldPos.applyMatrix4(parentWorldInv);
    obj.position.copy(worldPos);
  } else {
    obj.applyQuaternion(transform.rotation);
    obj.position.add(transform.translation);
  }
}

export function solveMateFromAnchors(
  source: THREE.Object3D,
  target: THREE.Object3D,
  sourceAnchor: { position: THREE.Vector3; normal: THREE.Vector3; tangent?: THREE.Vector3 },
  targetAnchor: { position: THREE.Vector3; normal: THREE.Vector3; tangent?: THREE.Vector3 },
  mode: MateMode,
  twistSpec?: TwistSpec
): MateTransform | null {
  const sourceCenterWorld = source.localToWorld(sourceAnchor.position.clone());
  const targetCenterWorld = target.localToWorld(targetAnchor.position.clone());
  const sourceNormalWorld = sourceAnchor.normal.clone().transformDirection(source.matrixWorld);
  const targetNormalWorld = targetAnchor.normal.clone().transformDirection(target.matrixWorld);
  const sourceTangentWorld = sourceAnchor.tangent
    ? sourceAnchor.tangent.clone().transformDirection(source.matrixWorld)
    : stableTangentFromNormal(sourceNormalWorld);
  const targetTangentWorld = targetAnchor.tangent
    ? targetAnchor.tangent.clone().transformDirection(target.matrixWorld)
    : stableTangentFromNormal(targetNormalWorld);

  return buildMateTransform(
    source,
    {
    sourceCenterWorld,
    targetCenterWorld,
    sourceNormalWorld,
    targetNormalWorld,
    sourceFaceLocal: sourceAnchor.position.clone(),
    targetFaceLocal: targetAnchor.position.clone(),
    sourceNormalLocal: sourceAnchor.normal.clone(),
    targetNormalLocal: targetAnchor.normal.clone(),
    sourceTangentWorld,
    targetTangentWorld,
    },
    mode,
    twistSpec
  );
}

function faceToDirection(face: FaceId) {
  switch (face) {
    case 'top':
      return new THREE.Vector3(0, 1, 0);
    case 'bottom':
      return new THREE.Vector3(0, -1, 0);
    case 'left':
      return new THREE.Vector3(-1, 0, 0);
    case 'right':
      return new THREE.Vector3(1, 0, 0);
    case 'front':
      return new THREE.Vector3(0, 0, 1);
    case 'back':
      return new THREE.Vector3(0, 0, -1);
    default:
      return new THREE.Vector3(0, 1, 0);
  }
}

function faceToTangent(face: FaceId) {
  switch (face) {
    case 'top':
    case 'bottom':
      return new THREE.Vector3(1, 0, 0);
    case 'left':
    case 'right':
      return new THREE.Vector3(0, 0, 1);
    case 'front':
    case 'back':
      return new THREE.Vector3(1, 0, 0);
    default:
      return new THREE.Vector3(1, 0, 0);
  }
}

function stableTangentFromNormal(normal: THREE.Vector3) {
  const n = normal.clone().normalize();
  const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(up, n).normalize();
}

function computeTwistFromTangents(sourceTangent: THREE.Vector3, targetTangent: THREE.Vector3, axis: THREE.Vector3) {
  const a = axis.clone().normalize();
  const u = sourceTangent.clone().projectOnPlane(a).normalize();
  const v = targetTangent.clone().projectOnPlane(a).normalize();
  if (u.lengthSq() < 1e-6 || v.lengthSq() < 1e-6) {
    return { quat: new THREE.Quaternion(), axisWorld: a, angleDeg: 0, source: 'tangent' as const };
  }
  const dot = THREE.MathUtils.clamp(u.dot(v), -1, 1);
  const angle = Math.acos(dot);
  const cross = new THREE.Vector3().crossVectors(u, v);
  const sign = Math.sign(cross.dot(a));
  const angleDeg = THREE.MathUtils.radToDeg(angle * sign);
  return {
    quat: new THREE.Quaternion().setFromAxisAngle(a, angle * sign),
    axisWorld: a,
    angleDeg,
    source: 'tangent' as const,
  };
}

function faceToAxis(face: FaceId): { axis: 'x' | 'y' | 'z'; sign: 1 | -1; vector: THREE.Vector3 } {
  switch (face) {
    case 'top':
      return { axis: 'y', sign: 1, vector: new THREE.Vector3(0, 1, 0) };
    case 'bottom':
      return { axis: 'y', sign: -1, vector: new THREE.Vector3(0, 1, 0) };
    case 'left':
      return { axis: 'x', sign: -1, vector: new THREE.Vector3(1, 0, 0) };
    case 'right':
      return { axis: 'x', sign: 1, vector: new THREE.Vector3(1, 0, 0) };
    case 'front':
      return { axis: 'z', sign: 1, vector: new THREE.Vector3(0, 0, 1) };
    case 'back':
      return { axis: 'z', sign: -1, vector: new THREE.Vector3(0, 0, 1) };
    default:
      return { axis: 'y', sign: 1, vector: new THREE.Vector3(0, 1, 0) };
  }
}

function buildFrame(normal: THREE.Vector3, tangent: THREE.Vector3) {
  const n = normal.clone().normalize();
  const t = tangent.clone().normalize();
  const b = new THREE.Vector3().crossVectors(n, t).normalize();
  return { normal: n, tangent: t, bitangent: b };
}

function axisFromSpec(
  spec: TwistSpec,
  sourceFrame: ReturnType<typeof buildFrame>,
  targetFrame: ReturnType<typeof buildFrame>,
  rotationNormal?: THREE.Quaternion
) {
  const axisToken = spec.axis;
  const space = spec.axisSpace;
  let axis = new THREE.Vector3(0, 1, 0);

  const axisFromFrame = (frame: ReturnType<typeof buildFrame>, token: string) => {
    if (token === 'normal') return frame.normal.clone();
    if (token === 'tangent') return frame.tangent.clone();
    if (token === 'bitangent') return frame.bitangent.clone();
    if (token === 'x') return frame.tangent.clone();
    if (token === 'y') return frame.normal.clone();
    if (token === 'z') return frame.bitangent.clone();
    return frame.normal.clone();
  };

  if (space === 'world') {
    if (axisToken === 'x') axis = new THREE.Vector3(1, 0, 0);
    else if (axisToken === 'y') axis = new THREE.Vector3(0, 1, 0);
    else if (axisToken === 'z') axis = new THREE.Vector3(0, 0, 1);
    else axis = new THREE.Vector3(0, 1, 0);
  } else if (space === 'source_face') {
    axis = axisFromFrame(sourceFrame, axisToken);
    if (rotationNormal) {
      axis = axis.clone().applyQuaternion(rotationNormal);
    }
  } else {
    axis = axisFromFrame(targetFrame, axisToken);
  }

  return axis.normalize();
}

function computeTwistFromSpec(
  spec: TwistSpec,
  sourceFrame: ReturnType<typeof buildFrame>,
  targetFrame: ReturnType<typeof buildFrame>,
  rotationNormal?: THREE.Quaternion
) {
  const axisWorld = axisFromSpec(spec, sourceFrame, targetFrame, rotationNormal);
  const angleRad = THREE.MathUtils.degToRad(spec.angleDeg);
  return {
    quat: new THREE.Quaternion().setFromAxisAngle(axisWorld, angleRad),
    axisWorld,
    angleDeg: spec.angleDeg,
    source: 'spec' as const,
  };
}

function quaternionToAxisAngle(q: THREE.Quaternion) {
  const quat = q.clone().normalize();
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(quat.w, -1, 1));
  const s = Math.sqrt(1 - quat.w * quat.w);
  if (s < 1e-6) {
    return { axis: new THREE.Vector3(0, 1, 0), angleDeg: 0 };
  }
  return {
    axis: new THREE.Vector3(quat.x / s, quat.y / s, quat.z / s),
    angleDeg: THREE.MathUtils.radToDeg(angle),
  };
}

function buildMateTransform(
  source: THREE.Object3D,
  inputs: PlaneInputs,
  mode: MateMode,
  twistSpec?: TwistSpec
): MateTransform {
  const {
    sourceCenterWorld,
    targetCenterWorld,
    sourceNormalWorld,
    targetNormalWorld,
    sourceTangentWorld,
    targetTangentWorld,
    sourceFaceLocal,
    targetFaceLocal,
    sourceNormalLocal,
    targetNormalLocal,
  } = inputs;

  const targetFacing = targetNormalWorld.clone().normalize().negate();
  const sourceFacing = sourceNormalWorld.clone().normalize();

  const sourceTangent = (sourceTangentWorld || stableTangentFromNormal(sourceNormalWorld)).clone().normalize();
  const targetTangent = (targetTangentWorld || stableTangentFromNormal(targetNormalWorld)).clone().normalize();
  const sourceFrame = buildFrame(sourceFacing, sourceTangent);
  const targetFrame = buildFrame(targetNormalWorld.clone().normalize(), targetTangent);

  let rotation = new THREE.Quaternion();
  let normalRotation: MateTransform['normalRotation'] = undefined;
  let twistRotation: MateTransform['twistRotation'] = undefined;
  if (mode === 'translate') {
    rotation.identity();
  } else if (mode === 'twist') {
    const twist =
      twistSpec
        ? computeTwistFromSpec(twistSpec, sourceFrame, targetFrame)
        : computeTwistFromTangents(sourceTangent, targetTangent, sourceFacing);
    rotation.copy(twist.quat);
    twistRotation = { axisWorld: twist.axisWorld, angleDeg: twist.angleDeg, source: twist.source };
  } else {
    const rotationNormal = new THREE.Quaternion().setFromUnitVectors(sourceFacing, targetFacing);
    const normalAxisAngle = quaternionToAxisAngle(rotationNormal);
    normalRotation = { axisWorld: normalAxisAngle.axis, angleDeg: normalAxisAngle.angleDeg };
    const rotatedTangent = sourceTangent.clone().applyQuaternion(rotationNormal);

    // When normals are already aligned (< 1°) and no explicit twistSpec was given,
    // skip tangent-based twist entirely.  computeClusterTangent picks the dominant
    // edge direction from a histogram which is non-deterministic for square/symmetric
    // parts — two identical flat plates can produce (1,0,0) on one and (0,0,1) on the
    // other, resulting in a spurious 90° twist that incorrectly rotates the source part.
    const normsAligned = !twistSpec && normalAxisAngle.angleDeg < 1;
    const twist =
      normsAligned
        ? { quat: new THREE.Quaternion(), axisWorld: targetFacing.clone().normalize(), angleDeg: 0, source: 'tangent' as const }
        : twistSpec
          ? computeTwistFromSpec(twistSpec, sourceFrame, targetFrame, rotationNormal)
          : computeTwistFromTangents(rotatedTangent, targetTangent, targetFacing);

    // When no explicit twistSpec is given, rectangular parts have 4-fold symmetry
    // so we snap the auto-computed twist to the nearest 90° increment.
    // This eliminates noise from mesh triangulation and PCA direction ambiguity.
    let twistAngleDeg = twist.angleDeg;
    if (!twistSpec && !normsAligned) {
      twistAngleDeg = Math.round(twistAngleDeg / 90) * 90;
    }
    const twistQuat = (twistSpec && !normsAligned)
      ? twist.quat
      : new THREE.Quaternion().setFromAxisAngle(twist.axisWorld, THREE.MathUtils.degToRad(twistAngleDeg));

    rotation = twistQuat.clone().multiply(rotationNormal);
    twistRotation = { axisWorld: twist.axisWorld, angleDeg: twistAngleDeg, source: twist.source };
  }

  const sourceWorldPos = new THREE.Vector3();
  source.getWorldPosition(sourceWorldPos);
  const rotatedCenter = sourceCenterWorld.clone().sub(sourceWorldPos).applyQuaternion(rotation).add(sourceWorldPos);
  let translation: THREE.Vector3;
  if (mode === 'translate') {
    translation = targetCenterWorld.clone().sub(sourceCenterWorld);
  } else if (mode === 'twist') {
    translation = sourceCenterWorld.clone().sub(rotatedCenter);
  } else {
    translation = targetCenterWorld.clone().sub(rotatedCenter);
  }

  const normalAlignment = sourceNormalWorld
    .clone()
    .applyQuaternion(rotation)
    .dot(targetNormalWorld.clone().negate());

  const planeDistance = targetCenterWorld
    .clone()
    .sub(rotatedCenter)
    .dot(targetNormalWorld.clone().normalize());

  return {
    rotation,
    translation,
    pivotWorld: sourceCenterWorld.clone(),
    sourceFaceCenter: sourceCenterWorld,
    targetFaceCenter: targetCenterWorld,
    sourceFaceLocal,
    targetFaceLocal,
    sourceNormalLocal,
    targetNormalLocal,
    normalRotation,
    twistRotation,
    quality: {
      normalAlignment,
      planeDistance,
    },
  };
}
