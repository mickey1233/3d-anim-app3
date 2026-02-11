import { OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import React, { useRef } from 'react';
import { useV2Store } from '../../store/store';

export function OrbitCoordinator() {
  const controlsRef = useRef<any>(null);
  const isDragging = useV2Store((s) => s.interaction.isTransformDragging);

  useFrame(() => {
    if (controlsRef.current) {
      const enabled = !isDragging;
      controlsRef.current.enabled = enabled;
      if (import.meta.env.DEV) {
        (window as any).__V2_ORBIT_ENABLED__ = enabled;
      }
    }
  });

  return <OrbitControls ref={controlsRef} makeDefault />;
}
