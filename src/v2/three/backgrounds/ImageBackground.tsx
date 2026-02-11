import React from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';

export function ImageBackground({ url }: { url: string }) {
  const { scene } = useThree();
  const texture = useTexture(url);

  React.useEffect(() => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    scene.background = texture;
    return () => {
      if (scene.background === texture) {
        scene.background = null;
      }
    };
  }, [scene, texture]);

  return null;
}
