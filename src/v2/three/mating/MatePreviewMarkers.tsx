import React from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useV2Store, type AnchorMethodId } from '../../store/store';
import { resolveAnchor } from './anchorMethods';

type LocalAnchor = {
  partId: string;
  faceId: string;
  positionLocal: THREE.Vector3;
  normalLocal: THREE.Vector3;
};

export function MatePreviewMarkers() {
  const { scene } = useThree();
  const mateDraft = useV2Store((s) => s.mateDraft);
  const matePick = useV2Store((s) => s.matePick);
  const partsOrder = useV2Store((s) => s.parts.order);
  const setMatePreview = useV2Store((s) => s.setMatePreview);
  const sourcePick = matePick.source?.type === 'face' ? matePick.source : undefined;
  const targetPick = matePick.target?.type === 'face' ? matePick.target : undefined;
  const sourceOffset = mateDraft.sourceOffset;
  const targetOffset = mateDraft.targetOffset;

  const sourceLocalRef = React.useRef<LocalAnchor | null>(null);
  const targetLocalRef = React.useRef<LocalAnchor | null>(null);
  const sourceGroupRef = React.useRef<THREE.Group | null>(null);
  const targetGroupRef = React.useRef<THREE.Group | null>(null);
  const tmp = React.useRef(new THREE.Vector3()).current;
  const tmpNormal = React.useRef(new THREE.Vector3()).current;

  React.useEffect(() => {
    let sourceAnchor: LocalAnchor | null = null;
    let targetAnchor: LocalAnchor | null = null;

    if (mateDraft.sourceId && mateDraft.sourceFace) {
      const obj = scene.getObjectByProperty('uuid', mateDraft.sourceId);
      if (obj) {
        const resolved = resolveAnchor({
          object: obj,
          faceId: mateDraft.sourceFace,
          method: mateDraft.sourceMethod,
          pick: sourcePick,
          fallback: mateDraft.sourceMethod === 'picked' ? [] : undefined,
        });
        if (resolved) {
          const offset = new THREE.Vector3(sourceOffset[0], sourceOffset[1], sourceOffset[2]);
          sourceAnchor = {
            partId: mateDraft.sourceId,
            faceId: mateDraft.sourceFace,
            positionLocal: resolved.centerLocal.clone().add(offset),
            normalLocal: resolved.normalLocal.clone(),
          };
        }
      }
    }

    if (mateDraft.targetId && mateDraft.targetFace) {
      const obj = scene.getObjectByProperty('uuid', mateDraft.targetId);
      if (obj) {
        const resolved = resolveAnchor({
          object: obj,
          faceId: mateDraft.targetFace,
          method: mateDraft.targetMethod,
          pick: targetPick,
          fallback: mateDraft.targetMethod === 'picked' ? [] : undefined,
        });
        if (resolved) {
          const offset = new THREE.Vector3(targetOffset[0], targetOffset[1], targetOffset[2]);
          targetAnchor = {
            partId: mateDraft.targetId,
            faceId: mateDraft.targetFace,
            positionLocal: resolved.centerLocal.clone().add(offset),
            normalLocal: resolved.normalLocal.clone(),
          };
        }
      }
    }

    sourceLocalRef.current = sourceAnchor;
    targetLocalRef.current = targetAnchor;

    const toPreview = (
      anchor: LocalAnchor | null,
      meta?: { methodUsed?: AnchorMethodId; methodRequested?: AnchorMethodId; fallbackUsed?: boolean }
    ) => {
      if (!anchor) return undefined;
      const obj = scene.getObjectByProperty('uuid', anchor.partId);
      if (!obj) return undefined;
      const pos = anchor.positionLocal.clone().applyMatrix4(obj.matrixWorld);
      const n = anchor.normalLocal.clone().transformDirection(obj.matrixWorld).normalize();
      return {
        partId: anchor.partId,
        faceId: anchor.faceId,
        positionWorld: [pos.x, pos.y, pos.z] as [number, number, number],
        normalWorld: [n.x, n.y, n.z] as [number, number, number],
        methodUsed: meta?.methodUsed,
        methodRequested: meta?.methodRequested,
        fallbackUsed: meta?.fallbackUsed,
      };
    };

    const sourceObj = mateDraft.sourceId ? scene.getObjectByProperty('uuid', mateDraft.sourceId) : null;
    const targetObj = mateDraft.targetId ? scene.getObjectByProperty('uuid', mateDraft.targetId) : null;
    const sourceMeta =
      sourceObj && mateDraft.sourceFace
        ? resolveAnchor({
            object: sourceObj,
            faceId: mateDraft.sourceFace,
            method: mateDraft.sourceMethod,
            pick: sourcePick,
            fallback: mateDraft.sourceMethod === 'picked' ? [] : undefined,
          })
        : undefined;
    const targetMeta =
      targetObj && mateDraft.targetFace
        ? resolveAnchor({
            object: targetObj,
            faceId: mateDraft.targetFace,
            method: mateDraft.targetMethod,
            pick: targetPick,
            fallback: mateDraft.targetMethod === 'picked' ? [] : undefined,
          })
        : undefined;

    setMatePreview({
      source: toPreview(sourceAnchor, {
        methodUsed: sourceMeta?.method,
        methodRequested: sourceMeta?.requestedMethod,
        fallbackUsed: sourceMeta?.fallbackUsed,
      }),
      target: toPreview(targetAnchor, {
        methodUsed: targetMeta?.method,
        methodRequested: targetMeta?.requestedMethod,
        fallbackUsed: targetMeta?.fallbackUsed,
      }),
    });
  }, [
    mateDraft.sourceId,
    mateDraft.sourceFace,
    mateDraft.targetId,
    mateDraft.targetFace,
    mateDraft.sourceMethod,
    mateDraft.targetMethod,
    sourceOffset[0],
    sourceOffset[1],
    sourceOffset[2],
    targetOffset[0],
    targetOffset[1],
    targetOffset[2],
    sourcePick?.partId,
    sourcePick?.faceId,
    sourcePick?.position,
    sourcePick?.normal,
    targetPick?.partId,
    targetPick?.faceId,
    targetPick?.position,
    targetPick?.normal,
    partsOrder,
    scene,
    setMatePreview,
  ]);

  useFrame(() => {
    const update = (groupRef: React.RefObject<THREE.Group | null>, anchor: LocalAnchor | null) => {
      const marker = groupRef.current;
      if (!marker || !anchor) {
        if (marker) marker.visible = false;
        return;
      }
      const obj = scene.getObjectByProperty('uuid', anchor.partId);
      if (!obj) {
        marker.visible = false;
        return;
      }
      tmp.copy(anchor.positionLocal).applyMatrix4(obj.matrixWorld);
      marker.position.copy(tmp);
      tmpNormal.copy(anchor.normalLocal).transformDirection(obj.matrixWorld).normalize();
      marker.lookAt(tmp.clone().add(tmpNormal));
      marker.visible = true;
    };

    update(sourceGroupRef, sourceLocalRef.current);
    update(targetGroupRef, targetLocalRef.current);
  });

  return (
    <group>
      <group ref={sourceGroupRef} visible={false}>
        <mesh raycast={() => null} renderOrder={10}>
          <sphereGeometry args={[0.03, 16, 16]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.9} depthTest={false} />
        </mesh>
        <Html
          position={[0, 0.06, 0]}
          center
          style={{
            fontSize: '10px',
            color: '#67e8f9',
            background: 'rgba(0,0,0,0.6)',
            padding: '2px 4px',
            borderRadius: '4px',
            border: '1px solid rgba(103,232,249,0.4)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
          distanceFactor={8}
        >
          Source
        </Html>
      </group>
      <group ref={targetGroupRef} visible={false}>
        <mesh raycast={() => null} renderOrder={10}>
          <sphereGeometry args={[0.03, 16, 16]} />
          <meshBasicMaterial color="#f472b6" transparent opacity={0.9} depthTest={false} />
        </mesh>
        <Html
          position={[0, 0.06, 0]}
          center
          style={{
            fontSize: '10px',
            color: '#fbcfe8',
            background: 'rgba(0,0,0,0.6)',
            padding: '2px 4px',
            borderRadius: '4px',
            border: '1px solid rgba(244,114,182,0.4)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
          distanceFactor={8}
        >
          Target
        </Html>
      </group>
    </group>
  );
}
