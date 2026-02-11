import React, { useEffect, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';

export function TransformGizmo() {
  const { scene } = useThree();
  const selectedId = useV2Store((s) => s.selection.partId);
  const interactionMode = useV2Store((s) => s.interaction.mode);
  const setDragging = useV2Store((s) => s.setTransformDragging);
  const setPartOverride = useV2Store((s) => s.setPartOverride);
  const setPartOverrideSilent = useV2Store((s) => s.setPartOverrideSilent);
  const controlsRef = useRef<any>(null);

  const target = selectedId ? scene.getObjectByProperty('uuid', selectedId) : null;

  useEffect(() => {
    const ctrl = controlsRef.current;
    if (!ctrl) return;
    const handleDragging = (event: any) => {
      const dragging = !!event.value;
      setDragging(dragging);
      if (!dragging && target) {
        setPartOverride(target.uuid, {
          position: [target.position.x, target.position.y, target.position.z],
          quaternion: [target.quaternion.x, target.quaternion.y, target.quaternion.z, target.quaternion.w],
          scale: [target.scale.x, target.scale.y, target.scale.z],
        });
      }
    };
    const handleMouseDown = () => setDragging(true);
    const handleMouseUp = () => setDragging(false);
    ctrl.addEventListener('dragging-changed', handleDragging);
    ctrl.addEventListener('mouseDown', handleMouseDown);
    ctrl.addEventListener('mouseUp', handleMouseUp);
    return () => {
      ctrl.removeEventListener('dragging-changed', handleDragging);
      ctrl.removeEventListener('mouseDown', handleMouseDown);
      ctrl.removeEventListener('mouseUp', handleMouseUp);
    };
  }, [setDragging, setPartOverride, target]);

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
      size={1.6}
      onMouseDown={() => setDragging(true)}
      onObjectChange={() => {
        if (!target) return;
        setPartOverrideSilent(target.uuid, {
          position: [target.position.x, target.position.y, target.position.z],
          quaternion: [target.quaternion.x, target.quaternion.y, target.quaternion.z, target.quaternion.w],
          scale: [target.scale.x, target.scale.y, target.scale.z],
        });
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
