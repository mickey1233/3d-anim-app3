import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';
import { ENVIRONMENT_IMAGES, type EnvironmentPreset } from './backgrounds';

export function GeneratedBackground() {
  const { scene } = useThree();
  const env = useV2Store((s) => s.view.environment) as EnvironmentPreset;
  const texturesRef = React.useRef<Record<string, THREE.Texture>>({});
  const currentEnvRef = React.useRef(env);

  React.useEffect(() => {
    currentEnvRef.current = env;
    const tex = texturesRef.current[env];
    if (tex) {
      scene.background = tex;
    }
  }, [env, scene]);

  React.useEffect(() => {
    const loader = new THREE.TextureLoader();
    Object.entries(ENVIRONMENT_IMAGES).forEach(([key, url]) => {
      loader.load(url, (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        texturesRef.current[key] = tex;
        if (currentEnvRef.current === key) {
          scene.background = tex;
        }
      });
    });

    return () => {
      Object.values(texturesRef.current).forEach((tex) => tex.dispose());
      texturesRef.current = {};
      if (scene.background) scene.background = null;
    };
  }, [scene]);

  return null;
}
