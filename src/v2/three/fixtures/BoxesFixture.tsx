import React from 'react';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';

const BOXES = [
  { name: 'part1', position: [0, 0.6, 0] },
  { name: 'part2', position: [0.8, 0.2, -0.4] },
  { name: 'part3', position: [-0.7, 0.2, 0.5] },
  { name: 'part4', position: [0, 0, 0] },
] as const;

export function BoxesFixture() {
  const setParts = useV2Store((s) => s.setParts);
  const refs = React.useRef<THREE.Mesh[]>([]);

  React.useEffect(() => {
    const parts = refs.current
      .map((mesh, index) => {
        if (!mesh) return null;
        return { id: mesh.uuid, name: BOXES[index]?.name || mesh.uuid };
      })
      .filter(Boolean) as { id: string; name: string }[];

    const initialTransformById: Record<string, { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] }> = {};
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
      {BOXES.map((box, index) => (
        <mesh
          key={box.name}
          ref={(el) => {
            if (el) refs.current[index] = el;
          }}
          position={box.position as any}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.4, 0.2, 0.3]} />
          <meshStandardMaterial color={index % 2 === 0 ? '#c5a26e' : '#8da3c2'} metalness={0.1} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}
