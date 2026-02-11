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

export function clusterPlanarFaces(geometry: THREE.BufferGeometry): FaceCluster[] {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const clusters: FaceCluster[] = [];

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

    let cluster = clusters.find(
      (c) => c.normal.dot(normal) > NORMAL_DOT_THRESHOLD && Math.abs(c.planeConstant - planeConstant) < PLANE_EPS
    );

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
    }

    cluster.area += area;
    cluster.center.add(center.clone().multiplyScalar(area));
    cluster.points.push(vA, vB, vC);
  }

  clusters.forEach((c) => {
    if (c.area > 0) c.center.multiplyScalar(1 / c.area);
    c.tangent = computeClusterTangent(c);
  });

  return clusters;
}

function computeClusterTangent(cluster: FaceCluster) {
  const n = cluster.normal.clone().normalize();
  const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();

  const count = cluster.points.length;
  if (count === 0) return u.clone();

  let meanX = 0;
  let meanY = 0;
  for (const p of cluster.points) {
    meanX += p.dot(u);
    meanY += p.dot(v);
  }
  meanX /= count;
  meanY /= count;

  let a = 0;
  let b = 0;
  let c = 0;
  for (const p of cluster.points) {
    const x = p.dot(u) - meanX;
    const y = p.dot(v) - meanY;
    a += x * x;
    b += x * y;
    c += y * y;
  }
  a /= count;
  b /= count;
  c /= count;

  const trace = a + c;
  const det = a * c - b * b;
  const temp = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambda1 = trace / 2 + temp;

  let vx = 1;
  let vy = 0;
  if (Math.abs(b) > 1e-6) {
    vx = b;
    vy = lambda1 - a;
  } else if (a < c) {
    vx = 0;
    vy = 1;
  }

  const tangent = new THREE.Vector3()
    .addVectors(u.clone().multiplyScalar(vx), v.clone().multiplyScalar(vy))
    .normalize();

  return tangent.lengthSq() > 1e-6 ? tangent : u.clone();
}
