import * as THREE from 'three';
import { clusterPlanarFaces, type FaceCluster } from './faceClustering';
import type { Anchor } from '../anchors/types';
import type { AnchorMethodId, FaceId } from '../../store/store';

type FaceAnchor = Extract<Anchor, { type: 'face' }>;

export type AnchorResult = {
  centerLocal: THREE.Vector3;
  normalLocal: THREE.Vector3;
  tangentLocal: THREE.Vector3;
  method: AnchorMethodId;
  requestedMethod?: AnchorMethodId;
  fallbackUsed?: boolean;
  debug?: Record<string, any>;
};

export const ANCHOR_METHOD_OPTIONS: { id: AnchorMethodId; label: string }[] = [
  { id: 'auto', label: 'Auto (pick > geometry AABB)' },
  { id: 'planar_cluster', label: 'Planar Cluster' },
  { id: 'geometry_aabb', label: 'Geometry AABB' },
  { id: 'object_aabb', label: 'Object AABB' },
  { id: 'extreme_vertices', label: 'Extreme Vertices' },
  { id: 'obb_pca', label: 'OBB (PCA)' },
  { id: 'picked', label: 'Picked Face Only' },
];

const FACE_DIR: Record<FaceId, THREE.Vector3> = {
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
};

const vertexCache = new WeakMap<THREE.BufferGeometry, THREE.Vector3[]>();
const anchorByGeometryCache = new WeakMap<THREE.BufferGeometry, Map<string, AnchorResult>>();

function getVertices(geometry: THREE.BufferGeometry) {
  const cached = vertexCache.get(geometry);
  if (cached) return cached;
  const pos = geometry.attributes.position;
  const vertices: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3();
    v.fromBufferAttribute(pos as THREE.BufferAttribute, i);
    vertices.push(v);
  }
  vertexCache.set(geometry, vertices);
  return vertices;
}

function stableTangentFromNormal(normal: THREE.Vector3) {
  const n = normal.clone().normalize();
  const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(up, n).normalize();
}

function cloneAnchorResult(result: AnchorResult): AnchorResult {
  return {
    ...result,
    centerLocal: result.centerLocal.clone(),
    normalLocal: result.normalLocal.clone(),
    tangentLocal: result.tangentLocal.clone(),
    debug: result.debug ? { ...result.debug } : undefined,
  };
}

function getCachedGeometryAnchor(
  geometry: THREE.BufferGeometry,
  cacheKey: string,
  compute: () => AnchorResult | null
): AnchorResult | null {
  let geometryCache = anchorByGeometryCache.get(geometry);
  if (!geometryCache) {
    geometryCache = new Map();
    anchorByGeometryCache.set(geometry, geometryCache);
  }

  const cached = geometryCache.get(cacheKey);
  if (cached) return cloneAnchorResult(cached);

  const resolved = compute();
  if (!resolved) return null;

  geometryCache.set(cacheKey, cloneAnchorResult(resolved));
  return resolved;
}

function geometryCacheKey(method: AnchorMethodId, faceId: FaceId, geometry: THREE.BufferGeometry) {
  const posVersion = (geometry.attributes.position as any)?.version ?? 0;
  const indexVersion = geometry.index?.version ?? -1;
  return `${method}:${faceId}:${posVersion}:${indexVersion}`;
}

function getFaceClusterByDirection(geometry: THREE.BufferGeometry, direction: THREE.Vector3): FaceCluster | null {
  const clusters = clusterPlanarFaces(geometry);
  const dir = direction.clone().normalize();
  let best: FaceCluster | null = null;
  let bestScore = -Infinity;
  let bestArea = -Infinity;
  clusters.forEach((cluster) => {
    const score = cluster.normal.dot(dir);
    if (score > bestScore + 0.01 || (Math.abs(score - bestScore) <= 0.01 && cluster.area > bestArea)) {
      best = cluster;
      bestScore = score;
      bestArea = cluster.area;
    }
  });
  if (!best || bestScore < 0.1) return null;
  return best;
}

function resolvePlanarCluster(mesh: THREE.Mesh, faceId: FaceId): AnchorResult | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const cluster = getFaceClusterByDirection(geom, FACE_DIR[faceId]);
  if (!cluster) return null;
  return {
    centerLocal: cluster.center.clone(),
    normalLocal: cluster.normal.clone().normalize(),
    tangentLocal: cluster.tangent.clone().normalize(),
    method: 'planar_cluster',
    debug: { area: cluster.area },
  };
}

function resolveGeometryAabb(mesh: THREE.Mesh, faceId: FaceId): AnchorResult | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const box = geom.boundingBox;
  if (!box) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const dir = FACE_DIR[faceId].clone();
  const offset = new THREE.Vector3(dir.x * size.x * 0.5, dir.y * size.y * 0.5, dir.z * size.z * 0.5);
  const faceCenter = center.clone().add(offset);
  const normal = dir.clone().normalize();
  return {
    centerLocal: faceCenter,
    normalLocal: normal,
    tangentLocal: stableTangentFromNormal(normal),
    method: 'geometry_aabb',
  };
}

function resolveObjectAabb(object: THREE.Object3D, faceId: FaceId): AnchorResult | null {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const centerWorld = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const dirWorld = FACE_DIR[faceId].clone();
  const faceCenterWorld = centerWorld.clone().add(
    new THREE.Vector3(dirWorld.x * size.x * 0.5, dirWorld.y * size.y * 0.5, dirWorld.z * size.z * 0.5)
  );
  const centerLocal = object.worldToLocal(faceCenterWorld.clone());
  const normalWorld = dirWorld.clone().normalize();
  const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const normalLocal = normalWorld.clone().transformDirection(inv).normalize();
  return {
    centerLocal,
    normalLocal,
    tangentLocal: stableTangentFromNormal(normalLocal),
    method: 'object_aabb',
  };
}

function resolveExtremeVertices(mesh: THREE.Mesh, faceId: FaceId): AnchorResult | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const vertices = getVertices(geom);
  if (vertices.length === 0) return null;
  const dir = FACE_DIR[faceId].clone().normalize();
  let maxDot = -Infinity;
  vertices.forEach((v) => {
    const d = v.dot(dir);
    if (d > maxDot) maxDot = d;
  });
  const epsilon = 1e-3;
  const selected: THREE.Vector3[] = [];
  vertices.forEach((v) => {
    const d = v.dot(dir);
    if (Math.abs(d - maxDot) <= epsilon) selected.push(v);
  });
  const count = selected.length || vertices.length;
  const center = new THREE.Vector3();
  (selected.length ? selected : vertices).forEach((v) => center.add(v));
  center.multiplyScalar(1 / count);
  return {
    centerLocal: center,
    normalLocal: dir,
    tangentLocal: stableTangentFromNormal(dir),
    method: 'extreme_vertices',
    debug: { count },
  };
}

type EigenResult = { values: [number, number, number]; vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3] };

function jacobiEigenDecomposition(m: number[][]): EigenResult {
  let a = [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
    [m[2][0], m[2][1], m[2][2]],
  ];
  let v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const maxIter = 20;
  for (let iter = 0; iter < maxIter; iter++) {
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

    for (let k = 0; k < 3; k++) {
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

function resolveObbPca(mesh: THREE.Mesh, faceId: FaceId): AnchorResult | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const vertices = getVertices(geom);
  if (vertices.length === 0) return null;
  const mean = new THREE.Vector3();
  vertices.forEach((v) => mean.add(v));
  mean.multiplyScalar(1 / vertices.length);
  let c00 = 0,
    c01 = 0,
    c02 = 0,
    c11 = 0,
    c12 = 0,
    c22 = 0;
  vertices.forEach((v) => {
    const x = v.x - mean.x;
    const y = v.y - mean.y;
    const z = v.z - mean.z;
    c00 += x * x;
    c01 += x * y;
    c02 += x * z;
    c11 += y * y;
    c12 += y * z;
    c22 += z * z;
  });
  const invN = 1 / vertices.length;
  const cov = [
    [c00 * invN, c01 * invN, c02 * invN],
    [c01 * invN, c11 * invN, c12 * invN],
    [c02 * invN, c12 * invN, c22 * invN],
  ];
  const { values, vectors } = jacobiEigenDecomposition(cov);
  const order = [0, 1, 2].sort((a, b) => values[b] - values[a]);
  const axes = [vectors[order[0]], vectors[order[1]], vectors[order[2]]];

  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  vertices.forEach((v) => {
    const rel = v.clone().sub(mean);
    axes.forEach((axis, i) => {
      const d = rel.dot(axis);
      if (d < mins[i]) mins[i] = d;
      if (d > maxs[i]) maxs[i] = d;
    });
  });

  const faceDir = FACE_DIR[faceId].clone().normalize();
  let axisIndex = 0;
  let bestDot = -Infinity;
  axes.forEach((axis, i) => {
    const d = Math.abs(axis.dot(faceDir));
    if (d > bestDot) {
      bestDot = d;
      axisIndex = i;
    }
  });
  const axis = axes[axisIndex];
  const sign = Math.sign(axis.dot(faceDir)) || 1;
  const valuesAlong = axes.map((a, i) => (mins[i] + maxs[i]) * 0.5);
  valuesAlong[axisIndex] = sign > 0 ? maxs[axisIndex] : mins[axisIndex];

  const center = mean
    .clone()
    .add(axes[0].clone().multiplyScalar(valuesAlong[0]))
    .add(axes[1].clone().multiplyScalar(valuesAlong[1]))
    .add(axes[2].clone().multiplyScalar(valuesAlong[2]));

  const normal = axis.clone().multiplyScalar(sign).normalize();
  const tangent = axes[(axisIndex + 1) % 3].clone().normalize();
  return {
    centerLocal: center,
    normalLocal: normal,
    tangentLocal: tangent,
    method: 'obb_pca',
    debug: { axisIndex },
  };
}

function resolvePicked(pick: FaceAnchor): AnchorResult {
  return {
    centerLocal: new THREE.Vector3(...pick.position),
    normalLocal: new THREE.Vector3(...(pick.normal || [0, 1, 0])).normalize(),
    tangentLocal: pick.tangent
      ? new THREE.Vector3(...pick.tangent).normalize()
      : stableTangentFromNormal(new THREE.Vector3(...(pick.normal || [0, 1, 0]))),
    method: 'picked',
  };
}

export function resolveAnchor({
  object,
  faceId,
  method,
  pick,
  fallback = ['planar_cluster', 'geometry_aabb'] as AnchorMethodId[],
}: {
  object: THREE.Object3D;
  faceId: FaceId;
  method: AnchorMethodId;
  pick?: FaceAnchor;
  fallback?: AnchorMethodId[];
}): AnchorResult | null {
  const mesh = object as THREE.Mesh;
  const requestedMethod = method;
  const call = (m: AnchorMethodId): AnchorResult | null => {
    const geometry = (mesh.geometry as THREE.BufferGeometry | undefined) ?? undefined;
    switch (m) {
      case 'picked':
        return pick ? resolvePicked(pick) : null;
      case 'planar_cluster':
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('planar_cluster', faceId, geometry),
          () => resolvePlanarCluster(mesh, faceId)
        );
      case 'geometry_aabb':
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('geometry_aabb', faceId, geometry),
          () => resolveGeometryAabb(mesh, faceId)
        );
      case 'object_aabb':
        return resolveObjectAabb(object, faceId);
      case 'extreme_vertices':
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('extreme_vertices', faceId, geometry),
          () => resolveExtremeVertices(mesh, faceId)
        );
      case 'obb_pca':
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('obb_pca', faceId, geometry),
          () => resolveObbPca(mesh, faceId)
        );
      case 'auto':
        if (pick) return resolvePicked(pick);
        if (!geometry) return resolveObjectAabb(object, faceId);
        return (
          getCachedGeometryAnchor(
            geometry,
            geometryCacheKey('geometry_aabb', faceId, geometry),
            () => resolveGeometryAabb(mesh, faceId)
          ) ||
          getCachedGeometryAnchor(
            geometry,
            geometryCacheKey('planar_cluster', faceId, geometry),
            () => resolvePlanarCluster(mesh, faceId)
          )
        );
      default:
        return null;
    }
  };

  let result = call(method);
  if (result)
    return { ...result, requestedMethod, fallbackUsed: false };
  for (const fb of fallback) {
    result = call(fb);
    if (result) return { ...result, requestedMethod, fallbackUsed: true };
  }
  return null;
}
