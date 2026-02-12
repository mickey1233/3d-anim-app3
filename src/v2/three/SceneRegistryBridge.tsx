import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { registerV2Scene, registerV2ThreeContext } from './SceneRegistry';

export function SceneRegistryBridge() {
  const { scene, camera, gl, size } = useThree();
  useEffect(() => {
    registerV2Scene(scene);
    registerV2ThreeContext({
      scene,
      camera,
      renderer: gl,
      viewportPx: { width: size.width, height: size.height },
      devicePixelRatio: gl.getPixelRatio(),
    });
  }, [scene, camera, gl, size.width, size.height]);
  return null;
}
