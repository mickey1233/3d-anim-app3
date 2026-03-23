import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useLoader } from '@react-three/fiber';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import { useV2Store } from '../store/store';
import { extractPartsWithTransforms } from './SceneGraph';

// ── shared pointer-down handler logic ────────────────────────────────────────

function stableTangentFromNormal(normal: THREE.Vector3) {
  const n = normal.clone().normalize();
  const up =
    Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(up, n).normalize();
}

function usePointerDownHandler() {
  const setSelection = useV2Store((s) => s.setSelection);
  const addToMultiSelect = useV2Store((s) => s.addToMultiSelect);
  const removeFromMultiSelect = useV2Store((s) => s.removeFromMultiSelect);
  const clearMultiSelect = useV2Store((s) => s.clearMultiSelect);
  const pickMode = useV2Store((s) => s.interaction.pickFaceMode);
  const interactionMode = useV2Store((s) => s.interaction.mode);
  const setPickMode = useV2Store((s) => s.setPickFaceMode);
  const setMatePick = useV2Store((s) => s.setMatePick);

  return (e: any) => {
    if (!e.object?.isMesh) return;

    if (pickMode !== 'idle') {
      e.stopPropagation();
      const mesh = e.object as any;
      const localPoint = mesh.worldToLocal(e.point.clone());
      const localNormal = e.face?.normal?.clone().normalize();
      let localTangent: THREE.Vector3 | null = null;
      if (e.face && mesh.geometry?.attributes?.position) {
        const pos = mesh.geometry.attributes.position;
        const a = new THREE.Vector3().fromBufferAttribute(pos, e.face.a);
        const b = new THREE.Vector3().fromBufferAttribute(pos, e.face.b);
        const edge = b.clone().sub(a);
        if (localNormal) {
          localTangent = edge.clone().projectOnPlane(localNormal).normalize();
        }
      }
      if (!localTangent || localTangent.lengthSq() < 1e-6) {
        localTangent = localNormal
          ? stableTangentFromNormal(localNormal)
          : new THREE.Vector3(1, 0, 0);
      }
      const pickStore = useV2Store.getState();
      const pickParentUuid = mesh.parent?.uuid;
      const pickPartId =
        pickParentUuid && pickStore.parts.byId[pickParentUuid]
          ? pickParentUuid
          : mesh.uuid;
      setMatePick(pickMode, {
        type: 'face',
        partId: pickPartId,
        faceId: 'picked',
        position: [localPoint.x, localPoint.y, localPoint.z],
        normal: localNormal ? [localNormal.x, localNormal.y, localNormal.z] : [0, 1, 0],
        tangent: localTangent ? [localTangent.x, localTangent.y, localTangent.z] : undefined,
      });
      setPickMode('idle');
      return;
    }

    const shiftPressed = Boolean((e as any).nativeEvent?.shiftKey || e.shiftKey);
    if (interactionMode === 'rotate' && !shiftPressed) return;

    const ctrlPressed = Boolean(
      (e as any).nativeEvent?.ctrlKey ||
        e.ctrlKey ||
        (e as any).nativeEvent?.metaKey ||
        e.metaKey
    );

    if (ctrlPressed) {
      e.stopPropagation();
      const store = useV2Store.getState();
      const parentUuid = e.object.parent?.uuid;
      const partId =
        parentUuid && store.parts.byId[parentUuid]
          ? parentUuid
          : e.object.uuid;
      const currentMulti = store.multiSelectIds;
      if (currentMulti.length === 0 && store.selection.partId && store.selection.partId !== partId) {
        addToMultiSelect(store.selection.partId);
      }
      if (currentMulti.includes(partId)) {
        removeFromMultiSelect(partId);
      } else {
        addToMultiSelect(partId);
      }
      return;
    }

    e.stopPropagation();
    clearMultiSelect();
    // Resolve to the logical part node (parent groups multi-primitive meshes)
    const store = useV2Store.getState();
    const clickedUuid = e.object.uuid;
    const parentUuid = e.object.parent?.uuid;
    const partId =
      parentUuid && store.parts.byId[parentUuid]
        ? parentUuid
        : clickedUuid;
    setSelection(partId, 'canvas');
  };
}

// ── GLTF sub-component ────────────────────────────────────────────────────────

function GltfModelLoader({ cadUrl }: { cadUrl: string }) {
  const gltf = useGLTF(cadUrl, true);
  const setParts = useV2Store((s) => s.setParts);
  const onPointerDown = usePointerDownHandler();

  useEffect(() => {
    if (gltf?.scene) {
      const { parts, initialTransforms } = extractPartsWithTransforms(gltf.scene);
      setParts(parts, initialTransforms);
    }
  }, [gltf, setParts]);

  return <primitive object={gltf.scene} onPointerDown={onPointerDown} />;
}

// ── USDZ sub-component ────────────────────────────────────────────────────────

// USD files use centimeter units (metersPerUnit=0.01); Three.js uses metres.
// Apply uniform 0.01 scale so the model appears at the correct real-world size.
const USD_METERS_PER_UNIT = 0.01;

function UsdzModelLoader({ cadUrl }: { cadUrl: string }) {
  const scene = useLoader(USDZLoader, cadUrl) as unknown as THREE.Group;
  const setParts = useV2Store((s) => s.setParts);
  const onPointerDown = usePointerDownHandler();

  useEffect(() => {
    if (scene) {
      const { parts, initialTransforms } = extractPartsWithTransforms(scene);
      setParts(parts, initialTransforms);
    }
  }, [scene, setParts]);

  return (
    <primitive
      object={scene}
      scale={[USD_METERS_PER_UNIT, USD_METERS_PER_UNIT, USD_METERS_PER_UNIT]}
      onPointerDown={onPointerDown}
    />
  );
}

// ── ModelLoader ───────────────────────────────────────────────────────────────

export function ModelLoader() {
  const cadUrl = useV2Store((s) => s.cadUrl);
  const cadFileName = useV2Store((s) => s.cadFileName);

  if (!cadUrl) return null;

  const isUsdz = /\.usdz$/i.test(cadFileName ?? '');

  return (
    <React.Suspense fallback={null}>
      {isUsdz ? (
        <UsdzModelLoader cadUrl={cadUrl} />
      ) : (
        <GltfModelLoader cadUrl={cadUrl} />
      )}
    </React.Suspense>
  );
}
