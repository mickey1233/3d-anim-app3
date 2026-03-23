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

/** Strip Three.js auto-dedup suffix (_2, _3 …) from a node name. */
function stripDedupSuffix(name: string): string {
  return name.replace(/_\d+$/, '');
}

export function extractPartsWithTransforms(scene: THREE.Object3D): {
  parts: Part[];
  initialTransforms: Record<string, PartTransform>;
} {
  const parts: Part[] = [];
  const initialTransforms: Record<string, PartTransform> = {};
  const seen = new Set<string>();

  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;

    // Use the parent Object3D as the logical part node only when it is a true
    // GLTF multi-primitive node: all sibling Meshes share the same base name
    // (after stripping Three.js dedup suffixes like _2, _3 …).
    //
    // Counter-example: spark_0316.glb puts base, part1, part2 … as separate
    // mesh nodes all under one "spark_" Group.  Their sibling count > 1 but
    // their names are distinct, so each must remain its own independent part.
    const parent = mesh.parent;
    const siblingMeshes = parent
      ? parent.children.filter((c) => (c as THREE.Mesh).isMesh)
      : [];
    const meshBaseName = stripDedupSuffix(mesh.name);
    const allSiblingsShareBaseName =
      siblingMeshes.length > 1 &&
      meshBaseName.length > 0 &&
      siblingMeshes.every((s) => stripDedupSuffix(s.name) === meshBaseName);
    const partNode: THREE.Object3D = allSiblingsShareBaseName ? parent! : mesh;

    if (seen.has(partNode.uuid)) return;
    seen.add(partNode.uuid);

    const color = (mesh.material as any)?.color
      ? `#${(mesh.material as any).color.getHexString?.() ?? 'ffffff'}`
      : undefined;

    const rawName = partNode.name || mesh.name || `Part_${partNode.uuid.slice(0, 4)}`;
    const part: Part = {
      id: partNode.uuid,
      name: rawName,   // will be deduplicated below
      color,
    };
    parts.push(part);
    initialTransforms[part.id] = {
      position: [partNode.position.x, partNode.position.y, partNode.position.z],
      quaternion: [partNode.quaternion.x, partNode.quaternion.y, partNode.quaternion.z, partNode.quaternion.w],
      scale: [partNode.scale.x, partNode.scale.y, partNode.scale.z],
    };
  });

  // Strip Three.js dedup suffixes (_2, _3…) from names.
  // Only strip if the resulting base name is unique among all parts.
  const strippedNames = parts.map((p) => stripDedupSuffix(p.name));
  const nameCount = new Map<string, number>();
  for (const n of strippedNames) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  for (let i = 0; i < parts.length; i++) {
    const stripped = strippedNames[i];
    if ((nameCount.get(stripped) ?? 0) === 1) {
      parts[i] = { ...parts[i], name: stripped };
    }
  }

  return { parts, initialTransforms };
}
