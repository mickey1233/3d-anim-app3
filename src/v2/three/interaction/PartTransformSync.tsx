import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useV2Store } from '../../store/store';

export function PartTransformSync() {
  const { scene } = useThree();
  const parts = useV2Store((s) => s.parts);
  const prevOverridesRef = useRef(parts.overridesById);
  const prevInitialRef = useRef(parts.initialTransformById);

  useEffect(() => {
    if (!parts.order.length) return;
    const applyTransform = (id: string, transform?: any) => {
      const obj = scene.getObjectByProperty('uuid', id);
      if (!obj || !transform) return;
      const position = transform.position as [number, number, number];
      const quaternion = transform.quaternion as [number, number, number, number];
      const scale = transform.scale as [number, number, number];
      obj.position.set(position[0], position[1], position[2]);
      obj.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      obj.scale.set(scale[0], scale[1], scale[2]);
      obj.updateMatrix();
      obj.updateMatrixWorld();
    };

    const initialChanged = prevInitialRef.current !== parts.initialTransformById;

    if (initialChanged) {
      parts.order.forEach((id) => {
        const transform = parts.overridesById[id] || parts.initialTransformById[id];
        applyTransform(id, transform);
      });
    } else {
      Object.keys(parts.overridesById).forEach((id) => {
        applyTransform(id, parts.overridesById[id]);
      });
      Object.keys(prevOverridesRef.current).forEach((id) => {
        if (!parts.overridesById[id]) {
          applyTransform(id, parts.initialTransformById[id]);
        }
      });
    }

    prevOverridesRef.current = parts.overridesById;
    prevInitialRef.current = parts.initialTransformById;
  }, [scene, parts.order, parts.overridesById, parts.initialTransformById]);

  return null;
}
