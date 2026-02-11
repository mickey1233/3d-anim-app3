import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';

export function SelectionOutline() {
  const { scene } = useThree();
  const selectedId = useV2Store((s) => s.selection.partId);
  const targetRef = useRef<THREE.Object3D | null>(null);
  const boxRef = useRef<THREE.Box3>(new THREE.Box3());
  const [helper, setHelper] = useState<THREE.Box3Helper | null>(null);

  useEffect(() => {
    if (!selectedId) {
      targetRef.current = null;
      setHelper(null);
      return;
    }
    const obj = scene.getObjectByProperty('uuid', selectedId) || null;
    targetRef.current = obj;
    if (obj) {
      const h = new THREE.Box3Helper(boxRef.current, 0xffff00);
      setHelper(h);
    }
  }, [scene, selectedId]);

  useFrame(() => {
    if (helper && targetRef.current) {
      targetRef.current.updateWorldMatrix(true, true);
      boxRef.current.setFromObject(targetRef.current);
      helper.visible = !boxRef.current.isEmpty();
      helper.updateMatrixWorld(true);
    }
  });

  if (!helper) return null;
  return <primitive object={helper} />;
}
