import React, { useEffect, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useV2Store } from '../../store/store';

const GIZMO_RAYCAST_PRIORITY_FLAG = '__v2TransformGizmoHandle';

const markGizmoObjects = (root: any, enabled: boolean) => {
  if (!root || typeof root.traverse !== 'function') return;
  root.traverse((obj: any) => {
    if (!obj?.userData) return;
    if (enabled) obj.userData[GIZMO_RAYCAST_PRIORITY_FLAG] = true;
    else delete obj.userData[GIZMO_RAYCAST_PRIORITY_FLAG];
  });
};

export function TransformGizmo() {
  const { scene } = useThree();
  const selectedId = useV2Store((s) => s.selection.partId);
  const selectionGroupId = useV2Store((s) => s.selection.groupId);
  const multiSelectIds = useV2Store((s) => s.multiSelectIds);
  const interactionMode = useV2Store((s) => s.interaction.mode);
  const setDragging = useV2Store((s) => s.setTransformDragging);
  const setPartOverride = useV2Store((s) => s.setPartOverride);
  const setPartOverrideSilent = useV2Store((s) => s.setPartOverrideSilent);
  const setManualTransform = useV2Store((s) => s.setManualTransform);
  const gizmoSpace = useV2Store((s) => s.ui.gizmoSpace);
  const controlsRef = useRef<any>(null);

  // When multi-select is active, use the first item (or current selection if it's in the list)
  // as the gizmo primary, otherwise fall back to single selectedId.
  const effectivePrimaryId =
    multiSelectIds.length > 0
      ? (selectedId && multiSelectIds.includes(selectedId) ? selectedId : multiSelectIds[0])
      : selectedId;

  const target = effectivePrimaryId ? scene.getObjectByProperty('uuid', effectivePrimaryId) : null;

  // Drag tracking refs
  const dragMembersRef = useRef<string[]>([]);
  const primaryStartPosRef = useRef<THREE.Vector3 | null>(null);
  const primaryStartQuatRef = useRef<THREE.Quaternion | null>(null);
  const memberStartPositions = useRef<Map<string, THREE.Vector3>>(new Map());
  const memberStartQuaternions = useRef<Map<string, THREE.Quaternion>>(new Map());

  useEffect(() => {
    const ctrl = controlsRef.current;
    if (!ctrl) return;
    const helper = typeof ctrl.getHelper === 'function' ? ctrl.getHelper() : null;
    markGizmoObjects(ctrl, true);
    markGizmoObjects(helper, true);

    const handleDragging = (event: any) => {
      const dragging = !!event.value;
      setDragging(dragging);
      if (!dragging && target) {
        const finalTransform = {
          position: [target.position.x, target.position.y, target.position.z] as [number, number, number],
          quaternion: [target.quaternion.x, target.quaternion.y, target.quaternion.z, target.quaternion.w] as [number, number, number, number],
          scale: [target.scale.x, target.scale.y, target.scale.z] as [number, number, number],
        };
        // Commit members first (silent), then primary (with history)
        for (const memberId of dragMembersRef.current) {
          const memberObj = scene.getObjectByProperty('uuid', memberId);
          if (memberObj) {
            const memberTransform = {
              position: [memberObj.position.x, memberObj.position.y, memberObj.position.z] as [number, number, number],
              quaternion: [memberObj.quaternion.x, memberObj.quaternion.y, memberObj.quaternion.z, memberObj.quaternion.w] as [number, number, number, number],
              scale: [memberObj.scale.x, memberObj.scale.y, memberObj.scale.z] as [number, number, number],
            };
            setPartOverrideSilent(memberId, memberTransform);
            setManualTransform(memberId, memberTransform);
          }
        }
        setPartOverride(target.uuid, finalTransform);
        setManualTransform(target.uuid, finalTransform);
        // Reset drag state
        primaryStartPosRef.current = null;
        primaryStartQuatRef.current = null;
        memberStartPositions.current.clear();
        memberStartQuaternions.current.clear();
        dragMembersRef.current = [];
      }
    };

    const handleMouseDown = () => {
      setDragging(true);
      if (!target) {
        dragMembersRef.current = [];
        return;
      }

      // Resolve member IDs: multi-select takes priority over assemblyGroup
      let memberIds: string[] = [];
      const storeState = useV2Store.getState();
      if (multiSelectIds.length > 1) {
        memberIds = multiSelectIds.filter((id) => id !== effectivePrimaryId);
      } else if (selectionGroupId) {
        memberIds = storeState.getGroupParts(selectionGroupId).filter((id) => id !== target.uuid);
      }

      dragMembersRef.current = memberIds;
      primaryStartPosRef.current = target.position.clone();
      primaryStartQuatRef.current = target.quaternion.clone();
      memberStartPositions.current.clear();
      memberStartQuaternions.current.clear();

      for (const memberId of memberIds) {
        const memberObj = scene.getObjectByProperty('uuid', memberId);
        if (memberObj) {
          memberStartPositions.current.set(memberId, memberObj.position.clone());
          memberStartQuaternions.current.set(memberId, memberObj.quaternion.clone());
        }
      }
    };

    const handleMouseUp = () => setDragging(false);
    ctrl.addEventListener('dragging-changed', handleDragging);
    ctrl.addEventListener('mouseDown', handleMouseDown);
    ctrl.addEventListener('mouseUp', handleMouseUp);
    return () => {
      ctrl.removeEventListener('dragging-changed', handleDragging);
      ctrl.removeEventListener('mouseDown', handleMouseDown);
      ctrl.removeEventListener('mouseUp', handleMouseUp);
      markGizmoObjects(ctrl, false);
      markGizmoObjects(helper, false);
    };
  }, [setDragging, setPartOverride, setPartOverrideSilent, setManualTransform, target, scene, selectionGroupId, multiSelectIds, effectivePrimaryId]);

  useEffect(() => {
    const handleRelease = () => setDragging(false);
    window.addEventListener('pointerup', handleRelease);
    window.addEventListener('pointercancel', handleRelease);
    window.addEventListener('blur', handleRelease);
    return () => {
      window.removeEventListener('pointerup', handleRelease);
      window.removeEventListener('pointercancel', handleRelease);
      window.removeEventListener('blur', handleRelease);
    };
  }, [setDragging]);

  if (!target) return null;
  if (interactionMode !== 'move' && interactionMode !== 'rotate') return null;

  return (
    <TransformControls
      ref={controlsRef}
      object={target}
      mode={interactionMode === 'rotate' ? 'rotate' : 'translate'}
      space={gizmoSpace}
      size={1.6}
      onMouseDown={() => setDragging(true)}
      onObjectChange={() => {
        if (!target) return;
        setPartOverrideSilent(target.uuid, {
          position: [target.position.x, target.position.y, target.position.z],
          quaternion: [target.quaternion.x, target.quaternion.y, target.quaternion.z, target.quaternion.w],
          scale: [target.scale.x, target.scale.y, target.scale.z],
        });

        if (dragMembersRef.current.length > 0 && primaryStartPosRef.current && primaryStartQuatRef.current) {
          const posDelta = new THREE.Vector3().subVectors(target.position, primaryStartPosRef.current);
          const rotDelta = target.quaternion.clone().multiply(primaryStartQuatRef.current.clone().invert());

          for (const memberId of dragMembersRef.current) {
            const memberObj = scene.getObjectByProperty('uuid', memberId);
            const startPos = memberStartPositions.current.get(memberId);
            const startQuat = memberStartQuaternions.current.get(memberId);
            if (!memberObj || !startPos || !startQuat) continue;

            // Apply rigid body delta: rotate relative position around primary's start pivot
            const relPos = startPos.clone().sub(primaryStartPosRef.current);
            relPos.applyQuaternion(rotDelta);
            memberObj.position.copy(primaryStartPosRef.current).add(posDelta).add(relPos);
            memberObj.quaternion.copy(rotDelta).multiply(startQuat);

            setPartOverrideSilent(memberId, {
              position: [memberObj.position.x, memberObj.position.y, memberObj.position.z],
              quaternion: [memberObj.quaternion.x, memberObj.quaternion.y, memberObj.quaternion.z, memberObj.quaternion.w],
              scale: [memberObj.scale.x, memberObj.scale.y, memberObj.scale.z],
            });
          }
        }
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        setDragging(true);
      }}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => {
        e.stopPropagation();
        setDragging(false);
      }}
    />
  );
}
