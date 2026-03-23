import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useV2Store } from '../store/store';

function azimuthElevationToPosition(azDeg: number, elDeg: number, r = 10): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [
    r * Math.cos(el) * Math.sin(az),
    r * Math.sin(el),
    r * Math.cos(el) * Math.cos(az),
  ];
}

export function LightingController() {
  const { gl } = useThree();
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const mainRef = useRef<THREE.DirectionalLight>(null);
  const fillRef = useRef<THREE.DirectionalLight>(null);

  const lighting = useV2Store((s) => s.view.lighting);

  useEffect(() => {
    gl.toneMappingExposure = lighting.exposure;
  }, [gl, lighting.exposure]);

  useEffect(() => {
    if (ambientRef.current) ambientRef.current.intensity = lighting.ambientIntensity;
  }, [lighting.ambientIntensity]);

  useEffect(() => {
    if (!mainRef.current) return;
    mainRef.current.intensity = lighting.mainIntensity;
    const [x, y, z] = azimuthElevationToPosition(lighting.azimuth, lighting.elevation);
    mainRef.current.position.set(x, y, z);
  }, [lighting.mainIntensity, lighting.azimuth, lighting.elevation]);

  return (
    <>
      <ambientLight ref={ambientRef} intensity={lighting.ambientIntensity} />
      <directionalLight
        ref={mainRef}
        position={azimuthElevationToPosition(lighting.azimuth, lighting.elevation)}
        intensity={lighting.mainIntensity}
        castShadow
      />
      <directionalLight ref={fillRef} position={[-4, 2, -3]} intensity={0.2} />
    </>
  );
}
