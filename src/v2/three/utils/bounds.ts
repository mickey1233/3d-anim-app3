import * as THREE from 'three';

export type RootLocalObb = {
  center: THREE.Vector3;
  size: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
};

function expandBoxByGeometryInRootSpace(root: THREE.Object3D, out: THREE.Box3) {
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const localToRoot = new THREE.Matrix4();
  const transformed = new THREE.Vector3();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.attributes?.position) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;

    localToRoot.multiplyMatrices(rootInverse, mesh.matrixWorld);
    const { min, max } = geometry.boundingBox;
    corners[0].set(min.x, min.y, min.z);
    corners[1].set(max.x, min.y, min.z);
    corners[2].set(max.x, max.y, min.z);
    corners[3].set(min.x, max.y, min.z);
    corners[4].set(min.x, min.y, max.z);
    corners[5].set(max.x, min.y, max.z);
    corners[6].set(max.x, max.y, max.z);
    corners[7].set(min.x, max.y, max.z);

    for (const corner of corners) {
      transformed.copy(corner).applyMatrix4(localToRoot);
      out.expandByPoint(transformed);
    }
    localToRoot.identity();
  });
}

function expandWithFallbackWorldAabb(root: THREE.Object3D, out: THREE.Box3) {
  const worldBox = new THREE.Box3().setFromObject(root);
  if (worldBox.isEmpty()) return;
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const corners = [
    new THREE.Vector3(worldBox.min.x, worldBox.min.y, worldBox.min.z),
    new THREE.Vector3(worldBox.max.x, worldBox.min.y, worldBox.min.z),
    new THREE.Vector3(worldBox.max.x, worldBox.max.y, worldBox.min.z),
    new THREE.Vector3(worldBox.min.x, worldBox.max.y, worldBox.min.z),
    new THREE.Vector3(worldBox.min.x, worldBox.min.y, worldBox.max.z),
    new THREE.Vector3(worldBox.max.x, worldBox.min.y, worldBox.max.z),
    new THREE.Vector3(worldBox.max.x, worldBox.max.y, worldBox.max.z),
    new THREE.Vector3(worldBox.min.x, worldBox.max.y, worldBox.max.z),
  ];
  for (const corner of corners) out.expandByPoint(corner.applyMatrix4(rootInverse));
}

export function computeRootLocalBoundingBox(root: THREE.Object3D) {
  root.updateWorldMatrix(true, true);
  const localBounds = new THREE.Box3().makeEmpty();
  expandBoxByGeometryInRootSpace(root, localBounds);
  if (localBounds.isEmpty()) expandWithFallbackWorldAabb(root, localBounds);
  return localBounds;
}

function jacobiEigenDecomposition(matrix: number[][]) {
  const a = [
    [matrix[0][0], matrix[0][1], matrix[0][2]],
    [matrix[1][0], matrix[1][1], matrix[1][2]],
    [matrix[2][0], matrix[2][1], matrix[2][2]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 20; iter += 1) {
    let p = 0;
    let q = 1;
    let max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) {
      max = Math.abs(a[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(a[1][2]) > max) {
      max = Math.abs(a[1][2]);
      p = 1;
      q = 2;
    }
    if (max < 1e-10) break;
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    const ap0 = a[p][0];
    const ap1 = a[p][1];
    const ap2 = a[p][2];
    const aq0 = a[q][0];
    const aq1 = a[q][1];
    const aq2 = a[q][2];

    a[p][0] = c * ap0 - s * aq0;
    a[p][1] = c * ap1 - s * aq1;
    a[p][2] = c * ap2 - s * aq2;
    a[q][0] = s * ap0 + c * aq0;
    a[q][1] = s * ap1 + c * aq1;
    a[q][2] = s * ap2 + c * aq2;

    a[0][p] = a[p][0];
    a[1][p] = a[p][1];
    a[2][p] = a[p][2];
    a[0][q] = a[q][0];
    a[1][q] = a[q][1];
    a[2][q] = a[q][2];

    for (let k = 0; k < 3; k += 1) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }

  const values: [number, number, number] = [a[0][0], a[1][1], a[2][2]];
  const vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(v[0][0], v[1][0], v[2][0]).normalize(),
    new THREE.Vector3(v[0][1], v[1][1], v[2][1]).normalize(),
    new THREE.Vector3(v[0][2], v[1][2], v[2][2]).normalize(),
  ];
  return { values, vectors };
}

function collectRootLocalSampledPoints(root: THREE.Object3D, maxSamplesPerMesh = 1200) {
  root.updateWorldMatrix(true, true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const localToRoot = new THREE.Matrix4();
  const localPoint = new THREE.Vector3();
  const points: THREE.Vector3[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!position) return;

    localToRoot.multiplyMatrices(rootInverse, mesh.matrixWorld);
    const stride = Math.max(1, Math.floor(position.count / maxSamplesPerMesh));
    for (let index = 0; index < position.count; index += stride) {
      localPoint.fromBufferAttribute(position, index);
      points.push(localPoint.clone().applyMatrix4(localToRoot));
    }
    localToRoot.identity();
  });

  return points;
}

export function computeRootLocalObb(root: THREE.Object3D): RootLocalObb | null {
  const points = collectRootLocalSampledPoints(root);
  if (points.length < 8) return null;

  const mean = new THREE.Vector3();
  for (const point of points) mean.add(point);
  mean.multiplyScalar(1 / points.length);

  let c00 = 0;
  let c01 = 0;
  let c02 = 0;
  let c11 = 0;
  let c12 = 0;
  let c22 = 0;
  for (const point of points) {
    const dx = point.x - mean.x;
    const dy = point.y - mean.y;
    const dz = point.z - mean.z;
    c00 += dx * dx;
    c01 += dx * dy;
    c02 += dx * dz;
    c11 += dy * dy;
    c12 += dy * dz;
    c22 += dz * dz;
  }
  const inv = 1 / points.length;
  const covariance = [
    [c00 * inv, c01 * inv, c02 * inv],
    [c01 * inv, c11 * inv, c12 * inv],
    [c02 * inv, c12 * inv, c22 * inv],
  ];
  const { values, vectors } = jacobiEigenDecomposition(covariance);
  const order = [0, 1, 2].sort((left, right) => values[right] - values[left]);
  const axis0 = vectors[order[0]].clone().normalize();
  const axis1 = vectors[order[1]].clone().normalize();
  const axis2 = vectors[order[2]].clone().normalize();
  if (new THREE.Vector3().crossVectors(axis0, axis1).dot(axis2) < 0) axis2.multiplyScalar(-1);
  const axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [axis0, axis1, axis2];

  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    const rel = point.clone().sub(mean);
    for (let index = 0; index < 3; index += 1) {
      const value = rel.dot(axes[index]);
      if (value < mins[index]) mins[index] = value;
      if (value > maxs[index]) maxs[index] = value;
    }
  }

  if (!Number.isFinite(mins[0]) || !Number.isFinite(maxs[0])) return null;
  const size = new THREE.Vector3(maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]);
  const center = mean
    .clone()
    .add(axes[0].clone().multiplyScalar((mins[0] + maxs[0]) * 0.5))
    .add(axes[1].clone().multiplyScalar((mins[1] + maxs[1]) * 0.5))
    .add(axes[2].clone().multiplyScalar((mins[2] + maxs[2]) * 0.5));

  return { center, size, axes };
}

