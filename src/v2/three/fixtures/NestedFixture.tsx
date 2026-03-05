import React from 'react';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';

// Fixture to reproduce world/local space bugs:
// - Parts are nested under a parent group with rotation/scale.
// - Store transforms are local, but mate planning often works in world.
const PARENT_ROT_Y = 0.55;
const PARENT_SCALE = 0.22;
const PARENT_POS: [number, number, number] = [1.4, 0, -0.6];

const PARTS = [
  { name: 'part1', position: [0, 0.2, 0] as [number, number, number], color: '#8da3c2' },
  // Start above part1, so bottom->top mating should translate downward.
  { name: 'part2', position: [0.05, 1.2, 0.02] as [number, number, number], color: '#c5a26e' },
];

export function NestedFixture() {
  const setParts = useV2Store((s) => s.setParts);
  const refs = React.useRef<Array<THREE.Mesh | null>>([]);

  React.useEffect(() => {
    const parts = refs.current
      .map((mesh, index) => {
        if (!mesh) return null;
        return { id: mesh.uuid, name: PARTS[index]?.name || mesh.uuid };
      })
      .filter(Boolean) as { id: string; name: string }[];

    const initialTransformById: Record<
      string,
      { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] }
    > = {};
    refs.current.forEach((mesh) => {
      if (!mesh) return;
      initialTransformById[mesh.uuid] = {
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        quaternion: [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
      };
    });

    if (parts.length) {
      setParts(parts, initialTransformById);
    }
  }, [setParts]);

  return (
    <group position={PARENT_POS} rotation={[0, PARENT_ROT_Y, 0]} scale={PARENT_SCALE}>
      {PARTS.map((part, index) => (
        <mesh
          key={part.name}
          name={part.name}
          ref={(el) => {
            refs.current[index] = el;
          }}
          position={part.position as any}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.5, 0.18, 0.42]} />
          <meshStandardMaterial color={part.color} metalness={0.1} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

