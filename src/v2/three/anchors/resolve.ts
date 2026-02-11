import * as THREE from 'three';
import { Anchor } from './types';

export function resolveAnchorWorld(anchor: Anchor, scene: THREE.Object3D) {
  const obj = scene.getObjectByProperty('uuid', anchor.partId);
  if (!obj) return null;

  const pos = new THREE.Vector3(...anchor.position);
  const worldPos = pos.clone().applyMatrix4(obj.matrixWorld);

  if (anchor.type === 'face') {
    const normal = new THREE.Vector3(...anchor.normal);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
    const worldNormal = normal.clone().applyMatrix3(normalMatrix).normalize();
    return { position: worldPos, normal: worldNormal };
  }

  return { position: worldPos };
}

