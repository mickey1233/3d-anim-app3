import React from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useV2Store } from '../../store/store';

// Fixture to reproduce a common smart-mate failure:
// - `planar_cluster` prefers the largest planar face in a direction, which can be an interior shelf.
// - `auto` prefers geometry AABB extremes (outer-most face).
// This creates an observable mismatch between chat smart-mate (method inferred) and manual mate (auto/auto).
export function ShelfFixture() {
  const setParts = useV2Store((s) => s.setParts);
  const refs = React.useRef<THREE.Mesh[]>([]);

  const shelfGeometry = React.useMemo(() => {
    const foot1 = new THREE.BoxGeometry(0.22, 0.06, 0.22);
    foot1.translate(-0.26, 0.03, -0.26);
    const foot2 = new THREE.BoxGeometry(0.22, 0.06, 0.22);
    foot2.translate(0.26, 0.03, 0.26);
    const shelf = new THREE.BoxGeometry(0.9, 0.02, 0.9);
    // Place the shelf above the feet so planar-cluster(bottom) picks this larger face,
    // while geometry AABB bottom still uses the feet.
    shelf.translate(0, 0.22, 0);

    const merged = mergeGeometries([foot1, foot2, shelf], false);
    merged.computeBoundingBox();
    merged.computeVertexNormals();
    foot1.dispose();
    foot2.dispose();
    shelf.dispose();
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
        geometry={shelfGeometry}
        position={[0, 0.72, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#c5a26e" metalness={0.08} roughness={0.65} />
      </mesh>

      <mesh
        ref={(el) => {
          if (el) refs.current[1] = el;
        }}
        position={[0, 0.05, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[1.4, 0.1, 1.4]} />
        <meshStandardMaterial color="#8da3c2" metalness={0.06} roughness={0.62} />
      </mesh>
    </group>
  );
}

