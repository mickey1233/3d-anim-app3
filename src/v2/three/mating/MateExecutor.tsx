import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';
import { applyMateTransform, solveMateTopBottom } from './solver';

function normalizeMateMethod(method: unknown) {
  if (typeof method !== 'string') return 'planar_cluster' as const;
  const normalized = method.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'extreme_vertices') return 'planar_cluster' as const;
  if (normalized === 'geometry_aabb') return 'geometry_aabb' as const;
  if (normalized === 'object_aabb') return 'object_aabb' as const;
  if (normalized === 'obb_pca') return 'obb_pca' as const;
  if (normalized === 'picked') return 'picked' as const;
  return 'planar_cluster' as const;
}

export function MateExecutor() {
  const { scene } = useThree();
  const req = useV2Store((s) => s.mateRequest);
  const clearMate = useV2Store((s) => s.clearMateRequest);
  const setMarker = useV2Store((s) => s.setMarker);
  const setPartOverride = useV2Store((s) => s.setPartOverride);
  const setMateTrace = useV2Store((s) => s.setMateTrace);
  const setMatePreview = useV2Store((s) => s.setMatePreview);
  const matePick = useV2Store((s) => s.matePick);
  const clearMatePick = useV2Store((s) => s.clearMatePick);

  useEffect(() => {
    if (!req) return;
    const source = scene.getObjectByProperty('uuid', req.sourceId);
    const target = scene.getObjectByProperty('uuid', req.targetId);
    if (!source || !target) {
      clearMate();
      return;
    }

    const mode = req.mode || 'translate';
    const twistSpec = req.twistSpec;

    // Sync THREE.js objects from store to ensure we use current positions (not stale React state)
    const storeState = useV2Store.getState();
    const srcStored =
      storeState.parts.overridesById[req.sourceId] || storeState.parts.initialTransformById[req.sourceId];
    if (srcStored) {
      source.position.set(srcStored.position[0], srcStored.position[1], srcStored.position[2]);
      source.quaternion.set(srcStored.quaternion[0], srcStored.quaternion[1], srcStored.quaternion[2], srcStored.quaternion[3]);
      source.updateMatrixWorld(true);
    }
    const tgtStored =
      storeState.parts.overridesById[req.targetId] || storeState.parts.initialTransformById[req.targetId];
    if (tgtStored) {
      target.position.set(tgtStored.position[0], tgtStored.position[1], tgtStored.position[2]);
      target.quaternion.set(tgtStored.quaternion[0], tgtStored.quaternion[1], tgtStored.quaternion[2], tgtStored.quaternion[3]);
      target.updateMatrixWorld(true);
    }

    const beforePos = new THREE.Vector3();
    const beforeQuat = new THREE.Quaternion();
    source.getWorldPosition(beforePos);
    source.getWorldQuaternion(beforeQuat);
    const sourceMethod = normalizeMateMethod(req.sourceMethod);
    const targetMethod = normalizeMateMethod(req.targetMethod);
    const targetPick = matePick.target?.type === 'face' ? matePick.target : undefined;
    const transform = solveMateTopBottom(
      source,
      target,
      req.sourceFace,
      req.targetFace,
      mode,
      twistSpec,
      sourceMethod,
      targetMethod,
      matePick.source,
      matePick.target,
      req.sourceOffset,
      req.targetOffset
    );
    if (!transform) {
      clearMate();
      return;
    }

    applyMateTransform(source, transform);
    setPartOverride(req.sourceId, {
      position: [source.position.x, source.position.y, source.position.z],
      quaternion: [source.quaternion.x, source.quaternion.y, source.quaternion.z, source.quaternion.w],
      scale: [source.scale.x, source.scale.y, source.scale.z],
    });

    const afterPos = new THREE.Vector3();
    const afterQuat = new THREE.Quaternion();
    source.getWorldPosition(afterPos);
    source.getWorldQuaternion(afterQuat);

    setMateTrace({
      ts: Date.now(),
      mode,
      sourceId: req.sourceId,
      targetId: req.targetId,
      sourceFace: req.sourceFace,
      targetFace: req.targetFace,
      pivotWorld: [transform.pivotWorld.x, transform.pivotWorld.y, transform.pivotWorld.z],
      translationWorld: [transform.translation.x, transform.translation.y, transform.translation.z],
      rotationQuat: [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w],
      normal: transform.normalRotation
        ? {
            axisWorld: [
              transform.normalRotation.axisWorld.x,
              transform.normalRotation.axisWorld.y,
              transform.normalRotation.axisWorld.z,
            ],
            angleDeg: transform.normalRotation.angleDeg,
          }
        : undefined,
      twist: transform.twistRotation
        ? {
            axisWorld: [
              transform.twistRotation.axisWorld.x,
              transform.twistRotation.axisWorld.y,
              transform.twistRotation.axisWorld.z,
            ],
            angleDeg: transform.twistRotation.angleDeg,
            source: transform.twistRotation.source,
          }
        : undefined,
      sourceBeforeWorld: {
        position: [beforePos.x, beforePos.y, beforePos.z],
        quaternion: [beforeQuat.x, beforeQuat.y, beforeQuat.z, beforeQuat.w],
      },
      sourceAfterWorld: {
        position: [afterPos.x, afterPos.y, afterPos.z],
        quaternion: [afterQuat.x, afterQuat.y, afterQuat.z, afterQuat.w],
      },
    });

    setMarker('start', {
      type: 'face',
      partId: req.sourceId,
      faceId: req.sourceFace,
      position: [
        transform.sourceFaceLocal.x,
        transform.sourceFaceLocal.y,
        transform.sourceFaceLocal.z,
      ],
      normal: [
        transform.sourceNormalLocal.x,
        transform.sourceNormalLocal.y,
        transform.sourceNormalLocal.z,
      ],
    });

    setMarker('end', {
      type: 'face',
      partId: req.targetId,
      faceId: targetPick?.faceId || req.targetFace,
      position: [
        transform.targetFaceLocal.x,
        transform.targetFaceLocal.y,
        transform.targetFaceLocal.z,
      ],
      normal: [
        transform.targetNormalLocal.x,
        transform.targetNormalLocal.y,
        transform.targetNormalLocal.z,
      ],
    });

    clearMate();
    clearMatePick();
    setMatePreview({});
  }, [req, scene, clearMate, setMarker, setPartOverride, matePick, clearMatePick, setMateTrace, setMatePreview]);

  return null;
}
