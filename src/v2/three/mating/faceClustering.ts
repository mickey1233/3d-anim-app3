import * as THREE from 'three';

export type FaceCluster = {
  id: string;
  normal: THREE.Vector3;
  planeConstant: number;
  area: number;
  center: THREE.Vector3;
  points: THREE.Vector3[];
  tangent: THREE.Vector3;
};

const NORMAL_DOT_THRESHOLD = 0.995;
const PLANE_EPS = 1e-3;

type FaceClusterCacheEntry = {
  posVersion: number;
  indexVersion: number;
  clusters: FaceCluster[];
};

const faceClusterCache = new WeakMap<THREE.BufferGeometry, FaceClusterCacheEntry>();

/**
 * Coarse normal key: round each component to 1 decimal place.
 * Two normals within the NORMAL_DOT_THRESHOLD (~5.7°) will always share a key
 * or be one step apart, keeping per-bucket candidate lists tiny (usually 0–2).
 */
function coarseNormalKey(nx: number, ny: number, nz: number): string {
  return `${Math.round(nx * 10)},${Math.round(ny * 10)},${Math.round(nz * 10)}`;
}

/**
 * HashMap lookup — checks the primary bucket and all 26 neighbours to handle
 * normals that sit exactly on a rounding boundary.  Still O(1) per call.
 */
function findClusterInMap(
  map: Map<string, FaceCluster[]>,
  normal: THREE.Vector3,
  planeConstant: number
): FaceCluster | null {
  const qx = Math.round(normal.x * 10);
  const qy = Math.round(normal.y * 10);
  const qz = Math.round(normal.z * 10);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = map.get(`${qx + dx},${qy + dy},${qz + dz}`);
        if (bucket) {
          const match = bucket.find(
            (c) => c.normal.dot(normal) > NORMAL_DOT_THRESHOLD && Math.abs(c.planeConstant - planeConstant) < PLANE_EPS
          );
          if (match) return match;
        }
      }
    }
  }
  return null;
}

function addClusterToMap(map: Map<string, FaceCluster[]>, cluster: FaceCluster) {
  const key = coarseNormalKey(cluster.normal.x, cluster.normal.y, cluster.normal.z);
  let bucket = map.get(key);
  if (!bucket) { bucket = []; map.set(key, bucket); }
  bucket.push(cluster);
}

export function clusterPlanarFaces(geometry: THREE.BufferGeometry): FaceCluster[] {
  const posVersion = (geometry.attributes.position as any)?.version ?? 0;
  const indexVersion = geometry.index?.version ?? -1;
  const cached = faceClusterCache.get(geometry);
  if (cached && cached.posVersion === posVersion && cached.indexVersion === indexVersion) {
    return cached.clusters;
  }

  const pos = geometry.attributes.position;
  const index = geometry.index;
  const clusters: FaceCluster[] = [];
  // HashMap for O(1) cluster lookup — eliminates the O(n×m) clusters.find() bottleneck
  const clusterMap = new Map<string, FaceCluster[]>();

  const getVertex = (i: number) => {
    const v = new THREE.Vector3();
    v.fromBufferAttribute(pos as THREE.BufferAttribute, i);
    return v;
  };

  const triCount = index ? index.count / 3 : pos.count / 3;

  for (let i = 0; i < triCount; i++) {
    const a = index ? index.getX(i * 3) : i * 3;
    const b = index ? index.getY(i * 3) : i * 3 + 1;
    const c = index ? index.getZ(i * 3) : i * 3 + 2;

    const vA = getVertex(a);
    const vB = getVertex(b);
    const vC = getVertex(c);

    const normal = new THREE.Vector3()
      .subVectors(vC, vB)
      .cross(new THREE.Vector3().subVectors(vA, vB))
      .normalize();

    const planeConstant = normal.dot(vA);
    const area = new THREE.Triangle(vA, vB, vC).getArea();
    const center = new THREE.Vector3().add(vA).add(vB).add(vC).multiplyScalar(1 / 3);

    let cluster = findClusterInMap(clusterMap, normal, planeConstant);

    if (!cluster) {
      cluster = {
        id: crypto.randomUUID(),
        normal: normal.clone(),
        planeConstant,
        area: 0,
        center: new THREE.Vector3(),
        points: [],
        tangent: new THREE.Vector3(1, 0, 0),
      };
      clusters.push(cluster);
      addClusterToMap(clusterMap, cluster);
    }

    cluster.area += area;
    cluster.center.add(center.clone().multiplyScalar(area));
    cluster.points.push(vA, vB, vC);
  }

  clusters.forEach((c) => {
    if (c.area > 0) c.center.multiplyScalar(1 / c.area);
    c.tangent = computeClusterTangent(c);
    c.points = [];
  });

  faceClusterCache.set(geometry, {
    posVersion,
    indexVersion,
    clusters,
  });

  return clusters;
}

/**
 * Compute the dominant tangent direction for a planar face cluster.
 *
 * Strategy: edge-length-weighted angle histogram.
 * For each triangle edge, project it onto the face plane, add its length
 * to the angle bin (folded into [0°, 180°) due to edge symmetry).
 * The peak bin gives the dominant edge direction — for rectangular faces this
 * is the long-axis direction regardless of how vertices are distributed inside
 * the face or how the mesh is triangulated.
 */
function computeClusterTangent(cluster: FaceCluster): THREE.Vector3 {
  const n = cluster.normal.clone().normalize();

  // Build an orthonormal frame in the face plane
  const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();

  const pts = cluster.points;
  if (pts.length < 3) return u.clone();

  // Angle histogram over [0°, 180°) in 1° steps
  const BINS = 180;
  const hist = new Float64Array(BINS);

  for (let i = 0; i + 2 < pts.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = pts[i + j];
      const b = pts[i + (j + 1) % 3];

      const eu = b.x * u.x + b.y * u.y + b.z * u.z - (a.x * u.x + a.y * u.y + a.z * u.z);
      const ev = b.x * v.x + b.y * v.y + b.z * v.z - (a.x * v.x + a.y * v.y + a.z * v.z);
      const len = Math.sqrt(eu * eu + ev * ev);
      if (len < 1e-7) continue;

      // Fold angle into [0, π) — edge direction is symmetric
      let angle = Math.atan2(ev, eu);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;

      const bin = Math.min(BINS - 1, Math.floor((angle / Math.PI) * BINS));
      hist[bin] += len;
    }
  }

  // Find the bin with maximum accumulated length (using a 3-bin smoothing window)
  let bestBin = 0;
  let bestVal = -1;
  for (let i = 0; i < BINS; i++) {
    const val = hist[i]
      + hist[(i - 1 + BINS) % BINS] * 0.5
      + hist[(i + 1) % BINS] * 0.5;
    if (val > bestVal) {
      bestVal = val;
      bestBin = i;
    }
  }

  // Compute weighted centroid angle inside a ±10-bin window around the peak
  let sumCos = 0;
  let sumSin = 0;
  for (let d = -10; d <= 10; d++) {
    const bi = (bestBin + d + BINS) % BINS;
    const angle = ((bi + 0.5) / BINS) * Math.PI;
    sumCos += Math.cos(angle) * hist[bi];
    sumSin += Math.sin(angle) * hist[bi];
  }

  const dominantAngle = Math.atan2(sumSin, sumCos);
  const tangent = new THREE.Vector3()
    .addScaledVector(u, Math.cos(dominantAngle))
    .addScaledVector(v, Math.sin(dominantAngle))
    .normalize();

  return tangent.lengthSq() > 1e-6 ? tangent : u.clone();
}
