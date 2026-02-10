/**
 * ArcballDrag — enables mouse drag rotation on the selected part when
 * interactionMode === 'rotate'.
 *
 * Runs entirely in the frontend for 60fps responsiveness. On pointerup,
 * the final rotation is committed to the store with undo history.
 *
 * Uses virtual trackball projection: NDC coords → sphere surface → axis/angle.
 */

import React, { useRef, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore } from '../../store/useAppStore';

/** Project NDC [x,y] onto a virtual unit sphere (Shoemake trackball). */
function projectToSphere(x: number, y: number): THREE.Vector3 {
  const d2 = x * x + y * y;
  if (d2 <= 0.5) {
    return new THREE.Vector3(x, y, Math.sqrt(1 - d2));
  }
  const t = 1 / Math.sqrt(2 * d2);
  return new THREE.Vector3(x, y, t).normalize();
}

interface DragState {
  active: boolean;
  partUuid: string;
  mesh: THREE.Object3D;
  startNDC: [number, number];
  startQuaternion: THREE.Quaternion;
  startRotation: [number, number, number];
  currentQuaternion: THREE.Quaternion;
}

export const ArcballDrag: React.FC = () => {
  const { gl, camera, scene } = useThree();
  const dragRef = useRef<DragState | null>(null);
  const controls = useThree((s) => s.controls) as any;

  const interactionMode = useAppStore((s) => s.interactionMode);
  const selectedPartId = useAppStore((s) => s.selectedPartId);

  const getNDC = useCallback((e: PointerEvent): [number, number] => {
    const rect = gl.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    return [x, y];
  }, [gl]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (interactionMode !== 'rotate' || !selectedPartId) return;

    // Raycast to check if clicking the selected part
    const ndc = getNDC(e);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), camera);

    const intersects = raycaster.intersectObjects(scene.children, true);
    const hit = intersects.find((i) => {
      let obj: THREE.Object3D | null = i.object;
      while (obj) {
        if (obj.uuid === selectedPartId) return true;
        obj = obj.parent;
      }
      return false;
    });

    if (!hit) return;

    // Find the part object
    let partObj: THREE.Object3D | null = hit.object;
    while (partObj && partObj.uuid !== selectedPartId) {
      partObj = partObj.parent;
    }
    if (!partObj) return;

    e.stopPropagation();

    // Disable orbit controls during drag
    if (controls && 'enabled' in controls) {
      controls.enabled = false;
    }

    const state = useAppStore.getState();
    const part = state.parts[selectedPartId];

    dragRef.current = {
      active: true,
      partUuid: selectedPartId,
      mesh: partObj,
      startNDC: ndc,
      startQuaternion: partObj.quaternion.clone(),
      startRotation: part ? [...part.rotation] as [number, number, number] : [0, 0, 0],
      currentQuaternion: partObj.quaternion.clone(),
    };

    gl.domElement.setPointerCapture(e.pointerId);
  }, [interactionMode, selectedPartId, camera, scene, gl, controls, getNDC]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !drag.active) return;

    const currentNDC = getNDC(e);

    const v0 = projectToSphere(drag.startNDC[0], drag.startNDC[1]);
    const v1 = projectToSphere(currentNDC[0], currentNDC[1]);

    const axis = new THREE.Vector3().crossVectors(v0, v1);
    if (axis.length() < 1e-6) return;
    axis.normalize();

    const angle = Math.acos(Math.min(1, Math.max(-1, v0.dot(v1))));

    // Convert axis from camera space to world space
    const cameraQuat = camera.quaternion;
    const worldAxis = axis.applyQuaternion(cameraQuat);

    const deltaQ = new THREE.Quaternion().setFromAxisAngle(worldAxis, angle);
    const newQ = deltaQ.clone().multiply(drag.startQuaternion);

    // Apply directly to mesh for real-time feedback
    drag.mesh.quaternion.copy(newQ);
    drag.currentQuaternion.copy(newQ);
  }, [camera, getNDC]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !drag.active) return;

    dragRef.current = null;

    // Re-enable orbit controls
    if (controls && 'enabled' in controls) {
      controls.enabled = true;
    }

    gl.domElement.releasePointerCapture(e.pointerId);

    // Commit to store with undo history
    const euler = new THREE.Euler().setFromQuaternion(drag.currentQuaternion);
    const newRot: [number, number, number] = [euler.x, euler.y, euler.z];

    const state = useAppStore.getState();
    state.updatePart(drag.partUuid, { rotation: newRot });
    state.pushHistory({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      description: 'arcball_rotate',
      partUuid: drag.partUuid,
      before: { position: state.parts[drag.partUuid].position, rotation: drag.startRotation },
      after: { position: state.parts[drag.partUuid].position, rotation: newRot },
    });
  }, [controls, gl]);

  // Attach native DOM events (more reliable than R3F for drag tracking)
  React.useEffect(() => {
    const el = gl.domElement;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
    };
  }, [gl, onPointerDown, onPointerMove, onPointerUp]);

  return null;
};
