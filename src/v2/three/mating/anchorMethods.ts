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
  { id: 'planar_cluster', label: 'Planar Cluster' },
  { id: 'face_projection', label: 'Face Projection' },
  { id: 'geometry_aabb', label: 'Geometry AABB' },
  { id: 'object_aabb', label: 'Object AABB' },
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

// Cache for group anchor results to avoid re-computing every frame.
const groupAnchorCache = new WeakMap<THREE.Object3D, Map<string, AnchorResult>>();
const groupFaceProjectionCache = new WeakMap<THREE.Object3D, Map<string, AnchorResult>>();

/**
 * Planar-cluster for multi-primitive Group parts.
 * Iterates every triangle across all child Meshes (in Group-local space),
 * keeps only triangles whose computed normal aligns with the requested face
 * direction (dot > NORMAL_THRESH), then picks the most extreme cluster and
 * returns its centroid — same semantics as resolvePlanarCluster on a single Mesh.
 */
function resolveGroupPlanarClusterCore(
  group: THREE.Object3D,
  faceId: FaceId,
  strategy: 'hybrid' | 'extremity',
  cache: WeakMap<THREE.Object3D, Map<string, AnchorResult>>,
  methodLabel: AnchorMethodId,
): AnchorResult | null {
  const cached = cache.get(group)?.get(faceId);
  if (cached) return cloneAnchorResult(cached);

  group.updateWorldMatrix(true, true);
  const groupWorldInv = new THREE.Matrix4().copy(group.matrixWorld).invert();

  // Strategy: first try world-space FACE_DIR transformed to group-local. This correctly
  // handles parts whose group has a non-identity rotation (e.g. a flipped part), so
  // face=top always means "the face pointing up in world space".
  // Fallback: use FACE_DIR directly in group-local (the part's own design coordinate
  // system). This handles cases where ancestor-only rotations (e.g. R_x(90°) on a
  // spark_ scale node) would cause the world-to-local direction to miss all faces.
  const localFaceDir = (FACE_DIR[faceId] ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
  const worldToLocalDir = localFaceDir.clone().transformDirection(groupWorldInv).normalize();

  const NORMAL_THRESH = 0.7; // cos(~45°) — face must roughly face the requested direction

  // FaceData now includes triangle area so we can weight clusters by surface area.
  type FaceData = { center: THREE.Vector3; normal: THREE.Vector3; area: number };

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const faceCenter = new THREE.Vector3();

  const collectAlignedFaces = (dir: THREE.Vector3): FaceData[] => {
    const faces: FaceData[] = [];
    group.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const geom = mesh.geometry;
      const pos = geom?.attributes?.position;
      if (!pos) return;

      mesh.updateWorldMatrix(false, false);
      const toGroupLocal = new THREE.Matrix4().copy(groupWorldInv).multiply(mesh.matrixWorld);

      const readVert = (i: number, out: THREE.Vector3) =>
        out.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(toGroupLocal);

      const processTri = (ai: number, bi: number, ci: number) => {
        readVert(ai, va); readVert(bi, vb); readVert(ci, vc);
        edge1.subVectors(vb, va);
        edge2.subVectors(vc, va);
        faceNormal.crossVectors(edge1, edge2);
        if (faceNormal.lengthSq() < 1e-12) return;
        const triArea = faceNormal.length() * 0.5;
        faceNormal.normalize();
        if (faceNormal.dot(dir) < NORMAL_THRESH) return;
        faceCenter.addVectors(va, vb).add(vc).divideScalar(3);
        faces.push({ center: faceCenter.clone(), normal: faceNormal.clone(), area: triArea });
      };

      const idx = geom.index;
      if (idx) {
        for (let i = 0; i < idx.count; i += 3) processTri(idx.array[i], idx.array[i + 1], idx.array[i + 2]);
      } else {
        for (let i = 0; i < pos.count; i += 3) processTri(i, i + 1, i + 2);
      }
    });
    return faces;
  };

  // Try world-space direction first; fall back to local-space direction.
  let alignedFaces = collectAlignedFaces(worldToLocalDir);
  let dir = worldToLocalDir;
  if (alignedFaces.length === 0) {
    alignedFaces = collectAlignedFaces(localFaceDir);
    dir = localFaceDir;
  }

  if (alignedFaces.length === 0) return null;

  // Compute projection range for plane-clustering tolerance.
  let maxProj = -Infinity;
  let minProj = Infinity;
  for (const f of alignedFaces) {
    const p = f.center.dot(dir);
    if (p > maxProj) maxProj = p;
    if (p < minProj) minProj = p;
  }

  // Group aligned faces into plane clusters by proximity along dir.
  // Use a tighter epsilon than the old extreme-cluster threshold — we want to
  // separate the exterior rim (high Y) from the interior floor (lower Y) on hollow
  // chassis bodies, which the old "cluster within 5% of extreme" approach merged.
  const projRange = maxProj - minProj;
  const modelScale = Math.max(Math.abs(maxProj), Math.abs(minProj), 1.0);
  const planeGap = Math.max(projRange * 0.015, modelScale * 3e-4);

  type PlaneCluster = { sumCenter: THREE.Vector3; totalArea: number; count: number; proj: number };
  const planeClusters: PlaneCluster[] = [];
  // Sort by projection so nearby faces are adjacent for O(n) clustering.
  alignedFaces.sort((a, b) => a.center.dot(dir) - b.center.dot(dir));
  for (const f of alignedFaces) {
    const proj = f.center.dot(dir);
    const last = planeClusters[planeClusters.length - 1];
    if (last && Math.abs(proj - last.proj) <= planeGap) {
      last.sumCenter.addScaledVector(f.center, f.area);
      last.totalArea += f.area;
      last.count += 1;
      // Update running mean projection
      last.proj += (proj - last.proj) / last.count;
    } else {
      planeClusters.push({
        sumCenter: f.center.clone().multiplyScalar(f.area),
        totalArea: f.area,
        count: 1,
        proj,
      });
    }
  }

  planeClusters.sort((a, b) => b.proj - a.proj);
  const extremeCluster = planeClusters[0];
  let best: typeof planeClusters[0];
  if (strategy === 'extremity') {
    // Pure extremity: always use the most extreme cluster — correct for solid/convex parts
    // (caps, connectors) where the mating face is the outermost surface.
    best = extremeCluster;
  } else {
    // Hybrid: extremity wins only when it has substantial area (≥15%).
    // Thin exterior rims should not win over the large interior floor for hollow parts.
    const totalAlignedArea = planeClusters.reduce((s, c) => s + c.totalArea, 0) || 1;
    const extremeFraction = extremeCluster.totalArea / totalAlignedArea;
    best = (extremeFraction >= 0.15)
      ? extremeCluster
      : planeClusters.reduce((b, c) => c.totalArea > b.totalArea ? c : b, planeClusters[0]);
  }
  const center = best.totalArea > 0
    ? best.sumCenter.clone().divideScalar(best.totalArea)   // area-weighted centroid
    : best.sumCenter.clone().divideScalar(best.count);

  if (import.meta.env?.DEV) {
    console.debug('[planar_cluster:group]', {
      group: group.name || group.uuid.slice(0, 8),
      faceId,
      strategy,
      alignedFaceCount: alignedFaces.length,
      planeClusters: planeClusters.map(c => ({ proj: c.proj.toFixed(4), area: c.totalArea.toFixed(4), count: c.count })),
      selectedProj: best.proj.toFixed(4),
      selectedArea: best.totalArea.toFixed(4),
      maxProj: maxProj.toFixed(4),
      minProj: minProj.toFixed(4),
      centerLocal: `(${center.x.toFixed(4)}, ${center.y.toFixed(4)}, ${center.z.toFixed(4)})`,
      normalUsed: `dir=(${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)})`,
    });
  }

  // Use the requested face direction as the normal, not the averaged geometry normal.
  // The averaged normal can be tilted when complex multi-primitive geometry includes
  // off-axis faces (e.g. curved walls, chamfers) in the cluster, causing an unwanted
  // rotation in face_flush mode.  The direction is already filtered to NORMAL_THRESH
  // (0.7), so all faces in the cluster are already roughly aligned with dir.
  const result: AnchorResult = {
    centerLocal: center,
    normalLocal: dir.clone(),
    tangentLocal: stableTangentFromNormal(dir),
    method: methodLabel,
  };

  if (!cache.has(group)) cache.set(group, new Map());
  cache.get(group)!.set(faceId, cloneAnchorResult(result));
  return result;
}

function resolveGroupPlanarCluster(group: THREE.Object3D, faceId: FaceId): AnchorResult | null {
  return resolveGroupPlanarClusterCore(group, faceId, 'hybrid', groupAnchorCache, 'planar_cluster');
}

function resolveGroupFaceProjection(group: THREE.Object3D, faceId: FaceId): AnchorResult | null {
  return resolveGroupPlanarClusterCore(group, faceId, 'extremity', groupFaceProjectionCache, 'face_projection');
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

/** Quantised world-rotation suffix so cached anchors are invalidated when the
 *  object rotates. Resolution ~0.01 rad keeps cache churn low. */
function rotationCacheKey(obj: THREE.Object3D): string {
  const q = new THREE.Quaternion();
  obj.getWorldQuaternion(q);
  return `${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)},${q.w.toFixed(2)}`;
}

function geometryCacheKey(
  method: AnchorMethodId,
  faceId: FaceId,
  geometry: THREE.BufferGeometry,
  rotKey = ''
) {
  const posVersion = (geometry.attributes.position as any)?.version ?? 0;
  const indexVersion = geometry.index?.version ?? -1;
  return `${method}:${faceId}:${posVersion}:${indexVersion}:${rotKey}`;
}

function getFaceClusterByDirection(geometry: THREE.BufferGeometry, direction: THREE.Vector3): FaceCluster | null {
  const clusters = clusterPlanarFaces(geometry);
  const dir = direction.clone().normalize();
  // Filter to clusters roughly aligned with the requested direction
  const aligned = clusters.filter(c => c.normal.dot(dir) >= 0.5);
  if (aligned.length === 0) return null;

  const totalArea = aligned.reduce((s, c) => s + c.area, 0) || 1;

  // Find the most extreme cluster along the direction (e.g. highest center.Y for "top").
  let extremeCluster = aligned[0];
  let extremeProj = extremeCluster.center.dot(dir);
  for (const c of aligned) {
    const proj = c.center.dot(dir);
    if (proj > extremeProj) { extremeCluster = c; extremeProj = proj; }
  }

  // Hybrid selection: prefer the most extreme cluster ONLY when it has substantial
  // surface area (not a thin rim). For hollow parts (trays, chassis), the exterior
  // top rim is the most extreme but has tiny area — the large interior floor is the
  // actual mating face. Threshold: extreme cluster must be ≥15% of total aligned area.
  if (extremeCluster.area / totalArea >= 0.15) return extremeCluster;

  // Fall back to the largest-area cluster (interior floor of tray, main body face, etc.)
  return aligned.reduce((best, c) => c.area > best.area ? c : best, aligned[0]);
}

function resolvePlanarCluster(mesh: THREE.Mesh, faceId: FaceId): AnchorResult | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  mesh.updateWorldMatrix(true, false);

  // Select face cluster by ranking WORLD-SPACE position of cluster centers.
  // For face='top': pick the cluster whose center is highest in world Y (and has a
  // roughly upward world normal). This correctly handles meshes under rotated parent
  // groups (e.g. the Spark GLB's R_x(90°) scale node) where local face normals are
  // not aligned with world axes.
  const worldFaceDir = (FACE_DIR[faceId] ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
  const meshWorldInv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const clusters = clusterPlanarFaces(geom);
  if (clusters.length === 0) return null;

  let bestCluster: FaceCluster | null = null;
  let bestScore = -Infinity;
  for (const c of clusters) {
    // Transform center and normal to world space.
    const worldNormal = c.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    const normalDot = worldNormal.dot(worldFaceDir);
    if (normalDot < 0.4) continue; // face must roughly face the world direction

    const worldCenter = c.center.clone().applyMatrix4(mesh.matrixWorld);
    // Score = world position along face direction (extremity), weighted by normal alignment and area.
    const score = worldCenter.dot(worldFaceDir) + normalDot * 0.1;
    if (score > bestScore) { bestScore = score; bestCluster = c; }
  }

  if (!bestCluster) return null;

  // normalLocal: use the world face direction back-transformed to mesh-local, so the
  // mate solver always gets the canonical face direction regardless of cluster tilt.
  const normalLocal = worldFaceDir.clone().transformDirection(meshWorldInv).normalize();
  return {
    centerLocal: bestCluster.center.clone(),
    normalLocal,
    tangentLocal: stableTangentFromNormal(normalLocal),
    method: 'planar_cluster',
    debug: { area: bestCluster.area },
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
  const extent = Math.abs(dir.x) * size.x * 0.5
    + Math.abs(dir.y) * size.y * 0.5
    + Math.abs(dir.z) * size.z * 0.5;
  const faceCenter = center.clone().addScaledVector(dir, extent);
  const normal = dir.clone();
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
  // Use FACE_DIR directly in mesh-local space (same reason as resolvePlanarCluster).
  const dir = (FACE_DIR[faceId] ?? new THREE.Vector3(0, 1, 0))
    .clone()
    .normalize();
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

function resolveFaceProjection(mesh: THREE.Mesh, faceId: FaceId): AnchorResult | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const clusters = clusterPlanarFaces(geom);
  if (clusters.length === 0) return null;
  // Use FACE_DIR directly in mesh-local space (same reason as resolvePlanarCluster).
  const dir = (FACE_DIR[faceId] ?? new THREE.Vector3(0, 1, 0))
    .clone()
    .normalize();
  let best: FaceCluster | null = null;
  let bestScore = -Infinity;
  for (const cluster of clusters) {
    const score = cluster.center.dot(dir);
    if (score > bestScore || (score === bestScore && best !== null && cluster.area > best.area)) {
      bestScore = score;
      best = cluster;
    }
  }
  if (!best) return null;
  return {
    centerLocal: best.center.clone(),
    normalLocal: best.normal.clone().normalize(),
    tangentLocal: best.tangent.clone().normalize(),
    method: 'face_projection',
    debug: { area: best.area, projectionScore: bestScore },
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

/** Ordered list of methods to try during VLM-based anchor verification */
export const ANCHOR_METHOD_VERIFY_ORDER: AnchorMethodId[] = [
  'planar_cluster',
  'face_projection',
  'geometry_aabb',
  'object_aabb',
];

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
  // Always ensure matrixWorld is current before any world↔local direction conversions.
  object.updateWorldMatrix(true, true);

  // If object is a Group (multi-primitive part: no direct geometry), redirect
  // geometry-based methods to resolveGroupPlanarCluster which merges all child
  // vertices into the Group's local space before computing the anchor.
  if (!(object as THREE.Mesh).geometry) {
    const requestedMethod = method;
    if (pick) {
      return { ...resolvePicked(pick), requestedMethod, fallbackUsed: method !== 'picked' };
    }
    if (method === 'object_aabb') {
      const aabb = resolveObjectAabb(object, faceId);
      return aabb ? { ...aabb, requestedMethod, fallbackUsed: false } : null;
    }
    // face_projection for groups: use pure extremity (correct for solid/convex parts)
    if (method === 'face_projection') {
      const result = resolveGroupFaceProjection(object, faceId) ?? resolveObjectAabb(object, faceId);
      return result ? { ...result, requestedMethod, fallbackUsed: result.method !== 'face_projection' } : null;
    }
    // For all geometry-based methods (planar_cluster, geometry_aabb, obb_pca, auto…)
    // use the merged-vertex planar-cluster approach, then fall back to object_aabb.
    const groupResult = resolveGroupPlanarCluster(object, faceId)
      ?? resolveObjectAabb(object, faceId);
    return groupResult
      ? { ...groupResult, requestedMethod, fallbackUsed: groupResult.method !== method }
      : null;
  }

  const mesh = object as THREE.Mesh;
  const requestedMethod = method;
  if (method === 'extreme_vertices') {
    // Temporarily disabled (kept for backward compatibility with older tool calls).
    method = 'planar_cluster';
  }
  const call = (m: AnchorMethodId): AnchorResult | null => {
    const geometry = (mesh.geometry as THREE.BufferGeometry | undefined) ?? undefined;
    switch (m) {
      case 'picked':
        return pick ? resolvePicked(pick) : null;
      case 'planar_cluster': {
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('planar_cluster', faceId, geometry, rotationCacheKey(mesh)),
          () => resolvePlanarCluster(mesh, faceId)
        );
      }
      case 'face_projection': {
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('face_projection', faceId, geometry, rotationCacheKey(mesh)),
          () => resolveFaceProjection(mesh, faceId)
        );
      }
      case 'geometry_aabb': {
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('geometry_aabb', faceId, geometry),
          () => resolveGeometryAabb(mesh, faceId)
        );
      }
      case 'object_aabb':
        return resolveObjectAabb(object, faceId);
      case 'extreme_vertices': {
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('extreme_vertices', faceId, geometry),
          () => resolveExtremeVertices(mesh, faceId)
        );
      }
      case 'obb_pca':
        if (!geometry) return null;
        return getCachedGeometryAnchor(
          geometry,
          geometryCacheKey('obb_pca', faceId, geometry),
          () => resolveObbPca(mesh, faceId)
        );
      case 'auto': {
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
      }
      default:
        return null;
    }
  };

  let result = call(method);
  if (result)
    return { ...result, requestedMethod, fallbackUsed: requestedMethod !== method };
  for (const fb of fallback) {
    result = call(fb);
    if (result) return { ...result, requestedMethod, fallbackUsed: true };
  }
  return null;
}

/**
 * Compute a world-space planar-cluster anchor aggregated from ALL objects in the list.
 * This is the group-aware source anchor computation: instead of using one representative
 * part's mesh, it collects face data from every mesh in every object (in world space),
 * clusters by plane alignment, and returns the best cluster center in world space.
 *
 * Called by action.mate_execute when sourceGroupId is provided, to compute a true
 * group-level source anchor for the offset correction (replacing AABB face center).
 */
export type GroupSourceCluster = {
  centerWorld: THREE.Vector3;
  normalWorld: THREE.Vector3;
  totalArea: number;
  proj: number;
  faceCount: number;
};

export function resolveAnchorFromObjectList(
  objects: THREE.Object3D[],
  faceId: FaceId,
): {
  centerWorld: THREE.Vector3;
  normalWorld: THREE.Vector3;
  alignedFaceCount: number;
  allClusters: GroupSourceCluster[];
  method: 'group_aggregate_planar_cluster';
} | null {
  const worldFaceDir = (FACE_DIR[faceId] ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
  const NORMAL_THRESH = 0.7;

  type FaceData = { center: THREE.Vector3; area: number };
  const faces: FaceData[] = [];

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const faceCenter = new THREE.Vector3();

  for (const obj of objects) {
    obj.updateWorldMatrix(true, true);
    obj.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const geom = mesh.geometry;
      const pos = geom?.attributes?.position;
      if (!pos) return;

      mesh.updateWorldMatrix(false, false);

      const readVert = (i: number, out: THREE.Vector3) =>
        out.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);

      const processTri = (ai: number, bi: number, ci: number) => {
        readVert(ai, va); readVert(bi, vb); readVert(ci, vc);
        edge1.subVectors(vb, va);
        edge2.subVectors(vc, va);
        faceNormal.crossVectors(edge1, edge2);
        if (faceNormal.lengthSq() < 1e-12) return;
        const triArea = faceNormal.length() * 0.5;
        faceNormal.normalize();
        // Filter: face must roughly point in the world face direction
        if (faceNormal.dot(worldFaceDir) < NORMAL_THRESH) return;
        faceCenter.addVectors(va, vb).add(vc).divideScalar(3);
        faces.push({ center: faceCenter.clone(), area: triArea });
      };

      const idx = geom.index;
      if (idx) {
        for (let i = 0; i < idx.count; i += 3) processTri(idx.array[i], idx.array[i + 1], idx.array[i + 2]);
      } else {
        for (let i = 0; i < pos.count; i += 3) processTri(i, i + 1, i + 2);
      }
    });
  }

  if (faces.length === 0) return null;

  // Plane-cluster faces along world face direction (same algorithm as resolveGroupPlanarClusterCore)
  const dir = worldFaceDir;
  let maxProj = -Infinity;
  let minProj = Infinity;
  for (const f of faces) {
    const p = f.center.dot(dir);
    if (p > maxProj) maxProj = p;
    if (p < minProj) minProj = p;
  }
  const projRange = maxProj - minProj;
  const modelScale = Math.max(Math.abs(maxProj), Math.abs(minProj), 1.0);
  const planeGap = Math.max(projRange * 0.015, modelScale * 3e-4);

  type PlaneCluster = { sumCenter: THREE.Vector3; totalArea: number; count: number; proj: number };
  const planeClusters: PlaneCluster[] = [];
  faces.sort((a, b) => a.center.dot(dir) - b.center.dot(dir));
  for (const f of faces) {
    const proj = f.center.dot(dir);
    const last = planeClusters[planeClusters.length - 1];
    if (last && Math.abs(proj - last.proj) <= planeGap) {
      last.sumCenter.addScaledVector(f.center, f.area);
      last.totalArea += f.area;
      last.count += 1;
      last.proj += (proj - last.proj) / last.count;
    } else {
      planeClusters.push({
        sumCenter: f.center.clone().multiplyScalar(f.area),
        totalArea: f.area,
        count: 1,
        proj,
      });
    }
  }

  planeClusters.sort((a, b) => b.proj - a.proj);
  const extremeCluster = planeClusters[0];
  const totalAlignedArea = planeClusters.reduce((s, c) => s + c.totalArea, 0) || 1;
  const extremeFraction = extremeCluster.totalArea / totalAlignedArea;
  const best = (extremeFraction >= 0.15)
    ? extremeCluster
    : planeClusters.reduce((b, c) => c.totalArea > b.totalArea ? c : b, planeClusters[0]);

  const centerWorld = best.totalArea > 0
    ? best.sumCenter.clone().divideScalar(best.totalArea)
    : best.sumCenter.clone().divideScalar(best.count);

  // Expose all clusters so callers can do target-proximity scoring instead of
  // relying solely on the extremity/area heuristic used for `centerWorld`.
  const allClusters: GroupSourceCluster[] = planeClusters.map((c) => ({
    centerWorld: c.totalArea > 0
      ? c.sumCenter.clone().divideScalar(c.totalArea)
      : c.sumCenter.clone().divideScalar(c.count),
    normalWorld: dir.clone(),
    totalArea: c.totalArea,
    proj: c.proj,
    faceCount: c.count,
  }));

  return { centerWorld, normalWorld: dir.clone(), alignedFaceCount: faces.length, allClusters, method: 'group_aggregate_planar_cluster' };
}
