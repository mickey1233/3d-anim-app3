import React from 'react';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';

const PARTS = [
  { name: 'part1', role: 'lid', position: [0, 0.75, 0], size: [0.95, 0.12, 0.95] },
  { name: 'part2', role: 'base', position: [0, 0.15, 0], size: [0.85, 0.22, 0.85] },
] as const;

export function LidFixture() {
  const setParts = useV2Store((s) => s.setParts);
  const refs = React.useRef<THREE.Mesh[]>([]);

  React.useEffect(() => {
    const parts = refs.current
      .map((mesh, index) => {
        if (!mesh) return null;
        const meta = PARTS[index];
        return { id: mesh.uuid, name: meta ? `${meta.name}` : mesh.uuid };
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
    <group>
      {PARTS.map((part, index) => (
        <mesh
          key={part.role}
          ref={(el) => {
            if (el) refs.current[index] = el;
          }}
          position={part.position as any}
          castShadow
          receiveShadow
        >
          <boxGeometry args={part.size as any} />
          <meshStandardMaterial
            color={part.role === 'lid' ? '#b5c7d3' : '#c6a979'}
            metalness={0.07}
            roughness={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

