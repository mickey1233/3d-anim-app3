import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';

// ---------------------------------------------------------------------------
// Compute a trimmed percentile AABB in obj-local space.
// Excludes the top/bottom `pct` fraction of vertex positions per axis, which
// removes the thin mounting-face vertices (at Y≈0 in the Spark GLB) that
// would otherwise make the bounding box extend far beyond the visible body.
// Result is cached by partId (geometry doesn't change when the part moves).
// ---------------------------------------------------------------------------
function computeLocalPercentileBox(obj: THREE.Object3D, pct = 0.02): THREE.Box3 {
  obj.updateWorldMatrix(true, true);
  const objWorldInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const v = new THREE.Vector3();
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count === 0) return;
    // Transform from mesh-local → obj-local
    const meshToObj = new THREE.Matrix4().multiplyMatrices(objWorldInv, mesh.matrixWorld);
    const stride = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(meshToObj);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  });
  if (xs.length === 0) return new THREE.Box3();
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const n = xs.length;
  const lo = Math.max(0, Math.round(n * pct));
  const hi = Math.min(n - 1, Math.round(n * (1 - pct)));
  return new THREE.Box3(
    new THREE.Vector3(xs[lo], ys[lo], zs[lo]),
    new THREE.Vector3(xs[hi], ys[hi], zs[hi]),
  );
}

const EDGE_VERTEX_COUNT = 24;
const POSITION_COMPONENTS = EDGE_VERTEX_COUNT * 3;
const EDGE_INDEXES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

function writeBoxEdgesToPositionArray(box: THREE.Box3, array: Float32Array) {
  const min = box.min;
  const max = box.max;
  const corners = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ];

  let cursor = 0;
  for (const [a, b] of EDGE_INDEXES) {
    const p0 = corners[a];
    const p1 = corners[b];
    array[cursor++] = p0.x;
    array[cursor++] = p0.y;
    array[cursor++] = p0.z;
    array[cursor++] = p1.x;
    array[cursor++] = p1.y;
    array[cursor++] = p1.z;
  }
}

function SingleOutline({ partId, color = 0xffff00 }: { partId: string; color?: number }) {
  const { scene } = useThree();
  const targetRef = useRef<THREE.Object3D | null>(null);
  // Percentile AABB in obj-local space — computed once per partId, reused every frame.
  const localBoxRef = useRef<THREE.Box3 | null>(null);
  const [helper, setHelper] = useState<THREE.LineSegments | null>(null);

  useEffect(() => {
    const obj = scene.getObjectByProperty('uuid', partId) || null;
    targetRef.current = obj;
    localBoxRef.current = obj ? computeLocalPercentileBox(obj) : null;
  }, [scene, partId]);

  useEffect(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POSITION_COMPONENTS), 3));
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: true });
    const line = new THREE.LineSegments(geometry, material);
    line.matrixAutoUpdate = false;
    setHelper(line);
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [partId, color]);

  useFrame(() => {
    if (!helper) return;
    const obj = targetRef.current;
    const localBox = localBoxRef.current;
    if (!obj || !localBox || localBox.isEmpty()) { helper.visible = false; return; }
    obj.updateWorldMatrix(true, true);
    // Render the local-space box at the object's current world transform.
    // This correctly handles rotation, scale, and movement without recomputing.
    const position = helper.geometry.getAttribute('position') as THREE.BufferAttribute;
    writeBoxEdgesToPositionArray(localBox, position.array as Float32Array);
    position.needsUpdate = true;
    helper.geometry.computeBoundingSphere();
    helper.matrix.copy(obj.matrixWorld);
    helper.matrixWorldNeedsUpdate = true;
    helper.visible = true;
  });

  if (!helper) return null;
  return <primitive object={helper} />;
}

function GroupOutline({ partIds, color = 0x00ff88 }: { partIds: string[]; color?: number }) {
  const { scene } = useThree();
  const [helper, setHelper] = useState<THREE.LineSegments | null>(null);

  useEffect(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POSITION_COMPONENTS), 3));
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: true });
    const line = new THREE.LineSegments(geometry, material);
    line.matrixAutoUpdate = false;
    setHelper(line);
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [color]);

  useFrame(() => {
    if (!helper) return;
    const combinedBox = new THREE.Box3();
    for (const id of partIds) {
      const obj = scene.getObjectByProperty('uuid', id);
      if (obj) {
        obj.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(obj);
        if (!box.isEmpty()) combinedBox.union(box);
      }
    }
    if (combinedBox.isEmpty()) {
      helper.visible = false;
      return;
    }
    const position = helper.geometry.getAttribute('position') as THREE.BufferAttribute;
    writeBoxEdgesToPositionArray(combinedBox, position.array as Float32Array);
    position.needsUpdate = true;
    helper.geometry.computeBoundingSphere();
    // Combined box is already in world space — use identity matrix
    helper.matrix.identity();
    helper.matrixWorldNeedsUpdate = true;
    helper.visible = true;
  });

  if (!helper) return null;
  return <primitive object={helper} />;
}

export function SelectionOutline() {
  const selectedId = useV2Store((s) => s.selection.partId);
  const multiSelectIds = useV2Store((s) => s.multiSelectIds);
  const selectionGroupId = useV2Store((s) => s.selection.groupId);
  const assemblyGroups = useV2Store((s) => s.assemblyGroups);

  // When multi-select is active, render cyan outlines for all items.
  if (multiSelectIds.length > 0) {
    return (
      <>
        {multiSelectIds.map((id) => (
          <SingleOutline key={id} partId={id} color={0x00cfff} />
        ))}
      </>
    );
  }

  // When a group is selected (explicit header click), OR when the selected part
  // belongs to any group — always render the full group AABB so the user can
  // see the entire module boundary.
  const effectiveGroupId =
    selectionGroupId ??
    (selectedId
      ? Object.entries(assemblyGroups.byId).find(([, g]) => g.partIds.includes(selectedId))?.[0]
      : null);

  if (effectiveGroupId) {
    const groupPartIds = assemblyGroups.byId[effectiveGroupId]?.partIds ?? [];
    if (groupPartIds.length > 0) {
      return <GroupOutline partIds={groupPartIds} color={0x00ff88} />;
    }
  }

  if (!selectedId) return null;
  return <SingleOutline partId={selectedId} color={0xffff00} />;
}
