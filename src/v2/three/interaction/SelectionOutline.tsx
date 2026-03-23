import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';
import { computeRootLocalBoundingBox, type RootLocalObb } from '../utils/bounds';

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

function writeObbEdgesToPositionArray(obb: RootLocalObb, array: Float32Array) {
  const [axisX, axisY, axisZ] = obb.axes;
  const half = obb.size.clone().multiplyScalar(0.5);
  const center = obb.center;
  const signs = [
    new THREE.Vector3(-1, -1, -1),
    new THREE.Vector3(1, -1, -1),
    new THREE.Vector3(1, 1, -1),
    new THREE.Vector3(-1, 1, -1),
    new THREE.Vector3(-1, -1, 1),
    new THREE.Vector3(1, -1, 1),
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(-1, 1, 1),
  ];
  const corners = signs.map((sign) =>
    center
      .clone()
      .add(axisX.clone().multiplyScalar(sign.x * half.x))
      .add(axisY.clone().multiplyScalar(sign.y * half.y))
      .add(axisZ.clone().multiplyScalar(sign.z * half.z))
  );

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

type OutlineShape = {
  obb: RootLocalObb | null;
  box: THREE.Box3 | null;
};

function SingleOutline({ partId, color = 0xffff00 }: { partId: string; color?: number }) {
  const { scene } = useThree();
  const targetRef = useRef<THREE.Object3D | null>(null);
  const localShapeRef = useRef<OutlineShape | null>(null);
  const [helper, setHelper] = useState<THREE.LineSegments | null>(null);

  useEffect(() => {
    const obj = scene.getObjectByProperty('uuid', partId) || null;
    targetRef.current = obj;
    localShapeRef.current = null;
  }, [scene, partId]);

  useEffect(() => {
    if (!targetRef.current) {
      setHelper(null);
      return () => {};
    }
    targetRef.current.updateWorldMatrix(true, true);
    const box = computeRootLocalBoundingBox(targetRef.current);
    localShapeRef.current = { obb: null, box: box.isEmpty() ? null : box };

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
    if (!helper || !targetRef.current || !localShapeRef.current) return;
    targetRef.current.updateWorldMatrix(true, true);
    const shape = localShapeRef.current;
    if (!shape.obb && !shape.box) { helper.visible = false; return; }
    const position = helper.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (shape.obb) writeObbEdgesToPositionArray(shape.obb, position.array as Float32Array);
    else if (shape.box) writeBoxEdgesToPositionArray(shape.box, position.array as Float32Array);
    position.needsUpdate = true;
    helper.geometry.computeBoundingSphere();
    helper.matrix.copy(targetRef.current.matrixWorld);
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

  // When a group is selected (from PartsPanel), render a single combined AABB outline.
  if (selectionGroupId) {
    const groupPartIds = assemblyGroups.byId[selectionGroupId]?.partIds ?? [];
    if (groupPartIds.length > 0) {
      return <GroupOutline partIds={groupPartIds} color={0x00ff88} />;
    }
  }

  if (!selectedId) return null;
  return <SingleOutline partId={selectedId} color={0xffff00} />;
}
