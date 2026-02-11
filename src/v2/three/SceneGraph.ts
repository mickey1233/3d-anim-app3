import * as THREE from 'three';
import { Part, type PartTransform } from '../store/store';

export function extractParts(scene: THREE.Object3D): Part[] {
  const parts: Part[] = [];

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const color = (mesh.material as any)?.color
        ? `#${(mesh.material as any).color.getHexString?.() ?? 'ffffff'}`
        : undefined;

      parts.push({
        id: mesh.uuid,
        name: mesh.name || `Part_${mesh.uuid.slice(0, 4)}`,
        color,
      });
    }
  });

  return parts;
}

export function extractPartsWithTransforms(scene: THREE.Object3D): {
  parts: Part[];
  initialTransforms: Record<string, PartTransform>;
} {
  const parts: Part[] = [];
  const initialTransforms: Record<string, PartTransform> = {};

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const color = (mesh.material as any)?.color
        ? `#${(mesh.material as any).color.getHexString?.() ?? 'ffffff'}`
        : undefined;

      const part: Part = {
        id: mesh.uuid,
        name: mesh.name || `Part_${mesh.uuid.slice(0, 4)}`,
        color,
      };
      parts.push(part);
      initialTransforms[part.id] = {
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        quaternion: [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
      };
    }
  });

  return { parts, initialTransforms };
}
