/**
 * PreviewRenderer — renders a wireframe ghost of the part at the preview position.
 *
 * When previewState.active is true, it finds the source mesh, clones its geometry,
 * and renders it at the preview transform with a transparent wireframe material.
 * If a path is provided, it animates along the keyframes.
 */

import React, { useRef, useMemo, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore } from '../../store/useAppStore';

const GHOST_COLOR = 0x3b82f6; // accent blue
const GHOST_OPACITY = 0.35;

export const PreviewRenderer: React.FC = () => {
  const { scene } = useThree();
  const ghostRef = useRef<THREE.Group>(null);
  const progressRef = useRef(0);
  const startTimeRef = useRef(0);

  const previewState = useAppStore((s) => s.previewState);
  const { active, partUuid, previewTransform, path, duration } = previewState;

  // Find source mesh and clone geometry
  const ghostMeshes = useMemo(() => {
    if (!active || !partUuid) return null;

    const sourceObj = scene.getObjectByProperty('uuid', partUuid);
    if (!sourceObj) return null;

    const meshes: { geometry: THREE.BufferGeometry; position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }[] = [];
    sourceObj.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        meshes.push({
          geometry: mesh.geometry,
          position: mesh.position.clone(),
          rotation: mesh.rotation.clone(),
          scale: mesh.scale.clone(),
        });
      }
    });

    return meshes;
  }, [active, partUuid, scene]);

  // Reset animation timer when preview starts
  useEffect(() => {
    if (active) {
      startTimeRef.current = 0;
      progressRef.current = 0;
    }
  }, [active]);

  // Animate along path or hold at preview position
  useFrame((_, delta) => {
    if (!ghostRef.current || !active || !previewTransform) return;

    if (path && path.length >= 2 && duration && duration > 0) {
      // Animate along path
      startTimeRef.current += delta;
      const t = Math.min(startTimeRef.current / duration, 1);
      progressRef.current = t;

      // Find the two keyframes to interpolate between
      let i = 0;
      while (i < path.length - 1 && path[i + 1].t <= t) i++;
      const kf0 = path[i];
      const kf1 = path[Math.min(i + 1, path.length - 1)];

      if (kf0.t === kf1.t) {
        ghostRef.current.position.set(kf0.position[0], kf0.position[1], kf0.position[2]);
        ghostRef.current.quaternion.set(kf0.quaternion[0], kf0.quaternion[1], kf0.quaternion[2], kf0.quaternion[3]);
      } else {
        const segT = (t - kf0.t) / (kf1.t - kf0.t);
        ghostRef.current.position.lerpVectors(
          new THREE.Vector3(kf0.position[0], kf0.position[1], kf0.position[2]),
          new THREE.Vector3(kf1.position[0], kf1.position[1], kf1.position[2]),
          segT,
        );
        const q0 = new THREE.Quaternion(kf0.quaternion[0], kf0.quaternion[1], kf0.quaternion[2], kf0.quaternion[3]);
        const q1 = new THREE.Quaternion(kf1.quaternion[0], kf1.quaternion[1], kf1.quaternion[2], kf1.quaternion[3]);
        ghostRef.current.quaternion.slerpQuaternions(q0, q1, segT);
      }

      // Loop animation
      if (t >= 1) {
        startTimeRef.current = 0;
      }
    } else {
      // Static preview position
      ghostRef.current.position.set(
        previewTransform.position[0],
        previewTransform.position[1],
        previewTransform.position[2],
      );
      ghostRef.current.quaternion.set(
        previewTransform.quaternion[0],
        previewTransform.quaternion[1],
        previewTransform.quaternion[2],
        previewTransform.quaternion[3],
      );
    }
  });

  if (!active || !ghostMeshes || ghostMeshes.length === 0) return null;

  return (
    <group ref={ghostRef}>
      {ghostMeshes.map((m, i) => (
        <mesh
          key={i}
          geometry={m.geometry}
          position={m.position}
          rotation={m.rotation}
          scale={m.scale}
        >
          <meshBasicMaterial
            color={GHOST_COLOR}
            wireframe
            transparent
            opacity={GHOST_OPACITY}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
};
