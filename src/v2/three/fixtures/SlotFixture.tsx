import React from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useV2Store } from '../../store/store';

export function SlotFixture() {
  const setParts = useV2Store((state) => state.setParts);
  const refs = React.useRef<THREE.Mesh[]>([]);

  const slotGeometry = React.useMemo(() => {
    const floor = new THREE.BoxGeometry(1.02, 0.08, 0.7);
    floor.translate(0, 0.04, 0);

    const leftWall = new THREE.BoxGeometry(0.18, 0.5, 0.7);
    leftWall.translate(-0.42, 0.25, 0);

    const rightWall = new THREE.BoxGeometry(0.18, 0.5, 0.7);
    rightWall.translate(0.42, 0.25, 0);

    const lipFront = new THREE.BoxGeometry(0.66, 0.14, 0.08);
    lipFront.translate(0, 0.07, 0.31);

    const lipBack = new THREE.BoxGeometry(0.66, 0.14, 0.08);
    lipBack.translate(0, 0.07, -0.31);

    const merged = mergeGeometries([floor, leftWall, rightWall, lipFront, lipBack], false);
    merged.computeBoundingBox();
    merged.computeVertexNormals();

    floor.dispose();
    leftWall.dispose();
    rightWall.dispose();
    lipFront.dispose();
    lipBack.dispose();
    return merged;
  }, []);

  React.useEffect(() => {
    const parts = refs.current
      .map((mesh, index) => {
        if (!mesh) return null;
        const name = index === 0 ? 'part1' : index === 1 ? 'part2' : mesh.uuid;
        return { id: mesh.uuid, name };
      })
      .filter(Boolean) as { id: string; name: string }[];

    const initialTransformById: Record<
      string,
      {
        position: [number, number, number];
        quaternion: [number, number, number, number];
        scale: [number, number, number];
      }
    > = {};

    refs.current.forEach((mesh) => {
      if (!mesh) return;
      initialTransformById[mesh.uuid] = {
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        quaternion: [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
      };
    });

    if (parts.length >= 2) setParts(parts, initialTransformById);
  }, [setParts]);

  return (
    <group>
      <mesh
        ref={(el) => {
          if (el) refs.current[0] = el;
        }}
        position={[0, 0.64, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[0.54, 0.22, 0.42]} />
        <meshStandardMaterial color="#8ea7c6" metalness={0.08} roughness={0.58} />
      </mesh>

      <mesh
        ref={(el) => {
          if (el) refs.current[1] = el;
        }}
        geometry={slotGeometry}
        position={[0, 0, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#c9aa73" metalness={0.06} roughness={0.64} />
      </mesh>
    </group>
  );
}
