import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useV2Store } from '../store/store';
import { extractPartsWithTransforms } from './SceneGraph';

export function ModelLoader() {
  const cadUrl = useV2Store((s) => s.cadUrl);
  const setParts = useV2Store((s) => s.setParts);
  const setSelection = useV2Store((s) => s.setSelection);
  const pickMode = useV2Store((s) => s.interaction.pickFaceMode);
  const interactionMode = useV2Store((s) => s.interaction.mode);
  const setPickMode = useV2Store((s) => s.setPickFaceMode);
  const setMatePick = useV2Store((s) => s.setMatePick);

  if (!cadUrl) return null;

  const stableTangentFromNormal = (normal: THREE.Vector3) => {
    const n = normal.clone().normalize();
    const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return new THREE.Vector3().crossVectors(up, n).normalize();
  };

  const gltf = useGLTF(cadUrl, true);

  useEffect(() => {
    if (gltf?.scene) {
      const { parts, initialTransforms } = extractPartsWithTransforms(gltf.scene);
      setParts(parts, initialTransforms);
    }
  }, [gltf, setParts]);

  return (
    <primitive
      object={gltf.scene}
      onPointerDown={(e: any) => {
        if (!e.object?.isMesh) return;

        if (pickMode !== 'idle') {
          e.stopPropagation();
          const mesh = e.object as any;
          const localPoint = mesh.worldToLocal(e.point.clone());
          const localNormal = e.face?.normal?.clone().normalize();
          let localTangent: THREE.Vector3 | null = null;
          if (e.face && mesh.geometry?.attributes?.position) {
            const pos = mesh.geometry.attributes.position;
            const a = new THREE.Vector3().fromBufferAttribute(pos, e.face.a);
            const b = new THREE.Vector3().fromBufferAttribute(pos, e.face.b);
            const edge = b.clone().sub(a);
            if (localNormal) {
              localTangent = edge.clone().projectOnPlane(localNormal).normalize();
            }
          }
          if (!localTangent || localTangent.lengthSq() < 1e-6) {
            localTangent = localNormal ? stableTangentFromNormal(localNormal) : new THREE.Vector3(1, 0, 0);
          }
          setMatePick(pickMode, {
            type: 'face',
            partId: mesh.uuid,
            faceId: 'picked',
            position: [localPoint.x, localPoint.y, localPoint.z],
            normal: localNormal
              ? [localNormal.x, localNormal.y, localNormal.z]
              : [0, 1, 0],
            tangent: localTangent ? [localTangent.x, localTangent.y, localTangent.z] : undefined,
          });
          setPickMode('idle');
          return;
        }

        const shiftPressed = Boolean((e as any).nativeEvent?.shiftKey || e.shiftKey);
        if (interactionMode === 'rotate' && !shiftPressed) {
          return;
        }

        e.stopPropagation();
        setSelection(e.object.uuid, 'canvas');
      }}
    />
  );
}
