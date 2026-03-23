import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useV2Store, type AnchorMethodId } from '../../store/store';
import { resolveAnchor } from './anchorMethods';

type LocalAnchor = {
  partId: string;
  faceId: string;
  positionLocal: THREE.Vector3;
  normalLocal: THREE.Vector3;
};

const PREVIEW_RESOLVE_DEBOUNCE_MS = 72;
const MIN_MARKER_RADIUS = 0.002;
const MARKER_RADIUS_FRACTION = 0.025; // 2.5% of the model's largest dimension

function buildPartObjectMap(scene: THREE.Scene, partIds: string[]) {
  const wanted = new Set(partIds);
  const map = new Map<string, THREE.Object3D>();
  if (wanted.size === 0) return map;
  scene.traverse((object) => {
    if (wanted.has(object.uuid) && !map.has(object.uuid)) {
      map.set(object.uuid, object);
    }
  });
  return map;
}

export function MatePreviewMarkers() {
  const { scene } = useThree();
  const mateDraft = useV2Store((s) => s.mateDraft);
  const matePick = useV2Store((s) => s.matePick);
  const partsOrder = useV2Store((s) => s.parts.order);
  const interactionMode = useV2Store((s) => s.interaction.mode);
  const workspaceSection = useV2Store((s) => s.ui.workspaceSection);
  const setMatePreview = useV2Store((s) => s.setMatePreview);
  const isMateContext = interactionMode === 'mate' || workspaceSection === 'mate';
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
  const idleHandleRef = React.useRef<number | null>(null);
  const partIdsKey = React.useMemo(() => partsOrder.join('|'), [partsOrder]);
  const objectByPartId = React.useMemo(
    () => buildPartObjectMap(scene, partsOrder),
    [scene, partIdsKey]
  );
  const findPartObject = React.useCallback(
    (partId: string) => objectByPartId.get(partId) ?? scene.getObjectByProperty('uuid', partId) ?? null,
    [objectByPartId]
  );

  // Compute marker radius as a fraction of the model's bounding box diagonal,
  // so markers are always visible regardless of model scale.
  const [markerRadius, setMarkerRadius] = React.useState(MIN_MARKER_RADIUS);
  React.useEffect(() => {
    if (objectByPartId.size === 0) return;
    const box = new THREE.Box3();
    for (const obj of objectByPartId.values()) {
      obj.updateWorldMatrix(true, true);
      const b = new THREE.Box3().setFromObject(obj);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    setMarkerRadius(Math.max(MIN_MARKER_RADIUS, maxDim * MARKER_RADIUS_FRACTION));
  }, [objectByPartId]);

  React.useEffect(() => {
    if (!isMateContext) {
      sourceLocalRef.current = null;
      targetLocalRef.current = null;
      setMatePreview({});
      return;
    }

    const resolvePreview = () => {
      let sourceAnchor: LocalAnchor | null = null;
      let targetAnchor: LocalAnchor | null = null;
      let sourceMeta:
        | {
            method: AnchorMethodId;
            requestedMethod?: AnchorMethodId;
            fallbackUsed?: boolean;
          }
        | undefined;
      let targetMeta:
        | {
            method: AnchorMethodId;
            requestedMethod?: AnchorMethodId;
            fallbackUsed?: boolean;
          }
        | undefined;

      if (mateDraft.sourceId && mateDraft.sourceFace) {
        const obj = findPartObject(mateDraft.sourceId);
        if (obj) {
          const resolved = resolveAnchor({
            object: obj,
            faceId: mateDraft.sourceFace,
            method: mateDraft.sourceMethod,
            pick: sourcePick,
            fallback: mateDraft.sourceMethod === 'picked' ? [] : undefined,
          });
          if (resolved) {
            sourceMeta = {
              method: resolved.method,
              requestedMethod: resolved.requestedMethod,
              fallbackUsed: resolved.fallbackUsed,
            };
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
        const obj = findPartObject(mateDraft.targetId);
        if (obj) {
          const resolved = resolveAnchor({
            object: obj,
            faceId: mateDraft.targetFace,
            method: mateDraft.targetMethod,
            pick: targetPick,
            fallback: mateDraft.targetMethod === 'picked' ? [] : undefined,
          });
          if (resolved) {
            targetMeta = {
              method: resolved.method,
              requestedMethod: resolved.requestedMethod,
              fallbackUsed: resolved.fallbackUsed,
            };
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
        const obj = findPartObject(anchor.partId);
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
    };

    const scheduleId = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        idleHandleRef.current = window.requestIdleCallback(resolvePreview, {
          timeout: PREVIEW_RESOLVE_DEBOUNCE_MS * 3,
        });
      } else {
        resolvePreview();
      }
    }, PREVIEW_RESOLVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(scheduleId);
      if (idleHandleRef.current !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandleRef.current);
        idleHandleRef.current = null;
      }
    };
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
    findPartObject,
    scene,
    setMatePreview,
    isMateContext,
  ]);

  useFrame(() => {
    if (!isMateContext) {
      if (sourceGroupRef.current) sourceGroupRef.current.visible = false;
      if (targetGroupRef.current) targetGroupRef.current.visible = false;
      return;
    }

    if (!sourceLocalRef.current || !targetLocalRef.current) {
      if (sourceGroupRef.current) sourceGroupRef.current.visible = false;
      if (targetGroupRef.current) targetGroupRef.current.visible = false;
      return;
    }

    const update = (groupRef: React.RefObject<THREE.Group | null>, anchor: LocalAnchor | null) => {
      const marker = groupRef.current;
      if (!marker || !anchor) {
        if (marker) marker.visible = false;
        return;
      }
      const obj = findPartObject(anchor.partId);
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
  }, 0);

  if (!isMateContext) return null;

  return (
    <group>
      <group ref={sourceGroupRef} visible={false}>
        <mesh raycast={() => null} renderOrder={10}>
          <sphereGeometry args={[markerRadius, 8, 8]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.76} />
        </mesh>
      </group>
      <group ref={targetGroupRef} visible={false}>
        <mesh raycast={() => null} renderOrder={10}>
          <sphereGeometry args={[markerRadius, 8, 8]} />
          <meshBasicMaterial color="#f472b6" transparent opacity={0.76} />
        </mesh>
      </group>
    </group>
  );
}
