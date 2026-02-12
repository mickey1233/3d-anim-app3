import React from 'react';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';

const PARTS = [
  { name: 'part1', position: [-0.6, 0.2, 0] },
  { name: 'part2', position: [0.6, 0.2, 0] },
] as const;

export function SideFixture() {
  const setParts = useV2Store((s) => s.setParts);
  const refs = React.useRef<THREE.Mesh[]>([]);

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
    <group>
      {PARTS.map((part, index) => (
        <mesh
          key={part.name}
          ref={(el) => {
            if (el) refs.current[index] = el;
          }}
          position={part.position as any}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.4, 0.25, 0.3]} />
          <meshStandardMaterial color={index === 0 ? '#d4b483' : '#88a2c2'} metalness={0.08} roughness={0.55} />
        </mesh>
      ))}
    </group>
  );
}

