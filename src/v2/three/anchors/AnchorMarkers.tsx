import React from 'react';
import { useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';
import { resolveAnchorWorld } from './resolve';

export function AnchorMarkers() {
  const { scene } = useThree();
  const markers = useV2Store((s) => s.markers);

  const start = markers.start ? resolveAnchorWorld(markers.start, scene) : null;
  const end = markers.end ? resolveAnchorWorld(markers.end, scene) : null;

  return (
    <>
      {start ? (
        <mesh position={start.position}>
          <sphereGeometry args={[0.03, 16, 16]} />
          <meshBasicMaterial color="#4ade80" />
        </mesh>
      ) : null}
      {end ? (
        <mesh position={end.position}>
          <sphereGeometry args={[0.03, 16, 16]} />
          <meshBasicMaterial color="#60a5fa" />
        </mesh>
      ) : null}
    </>
  );
}

