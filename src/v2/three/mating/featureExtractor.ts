/**
 * featureExtractor.ts — Multi-stage assembly feature extraction pipeline.
 *
 * Analyzes a THREE.Object3D and returns AssemblyFeature[] describing the
 * semantic assembly features present on the part (planar faces, holes, pegs, etc.).
 *
 * Pipeline stages (each independently exportable / replaceable):
 *   1. extractPlanarFaceFeatures — wraps clusterPlanarFaces, emits 'planar_face'
 *   2. extractCircleHoleFeatures — multi-hole detection via 2D clustering + Pratt fit
 *   3. extractPegFeatures        — orientation-agnostic peg detection (any support face)
 *   4. extractSlotFeatures       — slot detection via 2D PCA + bounding rect
 *   5. deduplicateFeatures       — merge near-identical planar/hole/peg features
 *
 * Backward compat: nothing here replaces clusterPlanarFaces or resolveAnchor.
 * extractFeatures() calls clusterPlanarFaces internally for stage 1.
 */

import * as THREE from 'three';
import { clusterPlanarFaces, type FaceCluster } from './faceClustering';
import type {
  AssemblyFeature,
  FeatureDimensions,
  FeaturePose,
  SemanticRole,
} from './featureTypes';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Gather all vertices from every Mesh in an Object3D into part-local space. */
function collectVerticesLocal(obj: THREE.Object3D): THREE.Vector3[] {
  const vertices: THREE.Vector3[] = [];
  obj.updateWorldMatrix(true, true);
  const worldInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();

  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    const pos = geom.attributes.position;
    if (!pos) return;
    mesh.updateWorldMatrix(false, false);
    const toLocal = new THREE.Matrix4().copy(worldInv).multiply(mesh.matrixWorld);
    const idx = geom.index;
    const vCount = pos.count;
    const v = new THREE.Vector3();
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        v.fromBufferAttribute(pos as THREE.BufferAttribute, idx.getX(i)).applyMatrix4(toLocal);
        vertices.push(v.clone());
      }
    } else {
      for (let i = 0; i < vCount; i++) {
        v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(toLocal);
        vertices.push(v.clone());
      }
    }
  });
  return vertices;
}

/** AABB of an Object3D computed in its own local space. */
function localBoundingBox(obj: THREE.Object3D): THREE.Box3 {
  const verts = collectVerticesLocal(obj);
  const box = new THREE.Box3();
  for (const v of verts) box.expandByPoint(v);
  return box;
}

/** Stable tangent from a normal vector. */
function stableTangent(n: THREE.Vector3): THREE.Vector3 {
  const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(up, n).normalize();
}

/**
 * Determine semantic role from feature type.
 */
function defaultSemanticRole(type: AssemblyFeature['type']): SemanticRole {
  switch (type) {
    case 'cylindrical_hole':
    case 'blind_hole':
    case 'slot':
    case 'socket':
      return 'receive';
    case 'peg':
    case 'tab':
    case 'edge_connector':
      return 'insert';
    case 'rail':
      return 'align';
    case 'planar_face':
    case 'support_pad':
      return 'support';
    case 'edge_notch':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Algebraic least-squares circle fit (Pratt method).
 * Fits a circle to a 2D point set.
 */
function fitCircleToPoints2D(
  points: Array<[number, number]>
): { cx: number; cy: number; r: number; residual: number; inlierRatio: number } | null {
  if (points.length < 6) return null;

  // Algebraic least squares circle fit
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  let sxxx = 0, sxxy = 0, sxyy = 0, syyy = 0;
  const n = points.length;

  for (const [x, y] of points) {
    sx += x; sy += y;
    sxx += x * x; sxy += x * y; syy += y * y;
    sxxx += x * x * x; sxxy += x * x * y; sxyy += x * y * y; syyy += y * y * y;
  }

  const a11 = sxx - (sx * sx) / n;
  const a12 = sxy - (sx * sy) / n;
  const a22 = syy - (sy * sy) / n;
  const b1 = 0.5 * (sxxx + sxyy - sx * (sxx + syy) / n);
  const b2 = 0.5 * (syyy + sxxy - sy * (sxx + syy) / n);

  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;

  const cx = (b1 * a22 - b2 * a12) / det;
  const cy = (b2 * a11 - b1 * a12) / det;

  // Average radius
  let sumR = 0;
  for (const [x, y] of points) sumR += Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const r = sumR / n;
  if (r < 1e-6) return null;

  // Residual = mean absolute deviation from circle
  let sumErr = 0;
  let inliers = 0;
  const tol = Math.max(0.0005, r * 0.1);
  for (const [x, y] of points) {
    const d = Math.abs(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r);
    sumErr += d;
    if (d <= tol) inliers++;
  }
  const residual = sumErr / n / r; // normalized residual
  const inlierRatio = inliers / n;

  return { cx, cy, r, residual, inlierRatio };
}

/**
 * Project vertices onto a plane defined by normal + origin.
 * Returns array of [u, v] coordinates in the plane.
 */
function projectToPlane(
  verts: THREE.Vector3[],
  normal: THREE.Vector3,
  planeOrigin: THREE.Vector3,
  tolerance: number
): Array<[number, number]> {
  const u = stableTangent(normal);
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  const planeD = normal.dot(planeOrigin);

  const projPoints: Array<[number, number]> = [];
  for (const vert of verts) {
    const dist = Math.abs(vert.dot(normal) - planeD);
    if (dist > tolerance) continue;
    const rel = vert.clone().sub(planeOrigin);
    projPoints.push([rel.dot(u), rel.dot(v)]);
  }
  return projPoints;
}

/**
 * Project 3D points to 2D on a plane (returning both projection and u/v basis vectors).
 */
function projectToPlaneWithBasis(
  verts: THREE.Vector3[],
  normal: THREE.Vector3,
  planeOrigin: THREE.Vector3,
  tolerance: number
): { points: Array<[number, number]>; u: THREE.Vector3; v: THREE.Vector3 } {
  const u = stableTangent(normal);
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  const planeD = normal.dot(planeOrigin);

  const points: Array<[number, number]> = [];
  for (const vert of verts) {
    const dist = Math.abs(vert.dot(normal) - planeD);
    if (dist > tolerance) continue;
    const rel = vert.clone().sub(planeOrigin);
    points.push([rel.dot(u), rel.dot(v)]);
  }
  return { points, u, v };
}

/**
 * Grid-bucket 2D clustering.
 * Groups 2D points into clusters using a fixed bucket size.
 * Returns array of clusters, each with their points.
 */
function gridCluster2D(
  points: Array<[number, number]>,
  bucketSize: number
): Array<Array<[number, number]>> {
  const buckets = new Map<string, Array<[number, number]>>();

  for (const [px, py] of points) {
    const bx = Math.floor(px / bucketSize);
    const by = Math.floor(py / bucketSize);
    const key = `${bx},${by}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push([px, py]);
  }

  // Merge adjacent buckets
  const visited = new Set<string>();
  const clusters: Array<Array<[number, number]>> = [];

  for (const [key, pts] of buckets) {
    if (visited.has(key)) continue;
    const [bx, by] = key.split(',').map(Number);
    const clusterPts: Array<[number, number]> = [...pts];
    visited.add(key);

    // Flood-fill adjacent buckets
    const queue = [[bx, by]];
    while (queue.length > 0) {
      const [cx, cy] = queue.pop()!;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = `${cx + dx},${cy + dy}`;
          if (!visited.has(nk) && buckets.has(nk)) {
            visited.add(nk);
            const npts = buckets.get(nk)!;
            clusterPts.push(...npts);
            queue.push([cx + dx, cy + dy]);
          }
        }
      }
    }

    clusters.push(clusterPts);
  }

  return clusters;
}

/**
 * 2D PCA: returns [principalAxis, secondaryAxis, eigenvalue1, eigenvalue2]
 * where eigenvalues represent variance along each axis.
 */
function pca2D(points: Array<[number, number]>): {
  axis1: [number, number];
  axis2: [number, number];
  lambda1: number;
  lambda2: number;
  centroid: [number, number];
} {
  const n = points.length;
  if (n < 2) return { axis1: [1, 0], axis2: [0, 1], lambda1: 0, lambda2: 0, centroid: [0, 0] };

  let mx = 0, my = 0;
  for (const [x, y] of points) { mx += x; my += y; }
  mx /= n; my /= n;

  let cxx = 0, cxy = 0, cyy = 0;
  for (const [x, y] of points) {
    const dx = x - mx, dy = y - my;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  cxx /= n; cxy /= n; cyy /= n;

  // Eigenvalues of 2x2 covariance matrix
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const l1 = trace / 2 + disc;
  const l2 = trace / 2 - disc;

  // Principal eigenvector
  let ax: number, ay: number;
  if (Math.abs(cxy) > 1e-12) {
    ax = l1 - cyy; ay = cxy;
  } else if (cxx >= cyy) {
    ax = 1; ay = 0;
  } else {
    ax = 0; ay = 1;
  }
  const len = Math.sqrt(ax * ax + ay * ay) || 1;
  ax /= len; ay /= len;

  return {
    axis1: [ax, ay],
    axis2: [-ay, ax],
    lambda1: l1,
    lambda2: l2,
    centroid: [mx, my],
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — Planar face features
// ---------------------------------------------------------------------------

/**
 * Extract planar face features from a single THREE.Mesh using clusterPlanarFaces.
 */
function extractPlanarFacesFromMesh(
  mesh: THREE.Mesh,
  partId: string,
  worldInv: THREE.Matrix4
): AssemblyFeature[] {
  const features: AssemblyFeature[] = [];
  const geom = mesh.geometry as THREE.BufferGeometry | undefined;
  if (!geom) return features;

  mesh.updateWorldMatrix(false, false);
  const toLocal = new THREE.Matrix4().copy(worldInv).multiply(mesh.matrixWorld);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(toLocal);

  const clusters: FaceCluster[] = clusterPlanarFaces(geom);

  for (const cluster of clusters) {
    if (cluster.area < 1e-6) continue;

    const centerLocal = cluster.center.clone().applyMatrix4(toLocal);
    const normalLocal = cluster.normal.clone().applyMatrix3(normalMatrix).normalize();

    const localPos: [number, number, number] = [centerLocal.x, centerLocal.y, centerLocal.z];
    const localAxis: [number, number, number] = [normalLocal.x, normalLocal.y, normalLocal.z];
    const tangent = stableTangent(normalLocal);
    const localSecondaryAxis: [number, number, number] = [tangent.x, tangent.y, tangent.z];

    const pose: FeaturePose = { localPosition: localPos, localAxis, localSecondaryAxis };
    const dims: FeatureDimensions = {
      area: cluster.area,
      tolerance: Math.sqrt(cluster.area) * 0.01,
    };

    const feature: AssemblyFeature = {
      id: crypto.randomUUID(),
      type: 'planar_face',
      partId,
      pose,
      dimensions: dims,
      semanticRole: 'support',
      supportFaceNormal: localAxis,
      confidence: Math.min(1, cluster.area * 1000),
      label: `planar face (area=${cluster.area.toFixed(4)})`,
      extractedBy: 'planar_cluster',
    };
    features.push(feature);
  }

  return features;
}

/**
 * Stage 1: Extract planar face features from all meshes in an Object3D.
 */
export function extractPlanarFaceFeatures(
  obj: THREE.Object3D,
  partId: string
): AssemblyFeature[] {
  try {
    obj.updateWorldMatrix(true, true);
    const worldInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const features: AssemblyFeature[] = [];

    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      features.push(...extractPlanarFacesFromMesh(mesh, partId, worldInv));
    });

    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractPlanarFaceFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — Multi-hole detection per planar face
// ---------------------------------------------------------------------------

/**
 * Stage 2: Extract cylindrical hole features from planar clusters by fitting circles
 * to clusters of vertices projected onto the cluster plane.
 *
 * Handles multiple holes per face via 2D grid clustering before circle fitting.
 */
export function extractCircleHoleFeatures(
  obj: THREE.Object3D,
  partId: string,
  planarFeatures: AssemblyFeature[]
): AssemblyFeature[] {
  try {
    const features: AssemblyFeature[] = [];
    obj.updateWorldMatrix(true, true);
    const worldInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();

    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;

      const geom = mesh.geometry as THREE.BufferGeometry;
      const pos = geom.attributes.position;
      if (!pos) return;

      mesh.updateWorldMatrix(false, false);
      const toLocal = new THREE.Matrix4().copy(worldInv).multiply(mesh.matrixWorld);

      // Build unique vertex list in part-local space
      const verts: THREE.Vector3[] = [];
      const idx = geom.index;
      if (idx) {
        const seen = new Set<number>();
        for (let i = 0; i < idx.count; i++) {
          const vi = idx.getX(i);
          if (!seen.has(vi)) {
            seen.add(vi);
            const v = new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, vi).applyMatrix4(toLocal);
            verts.push(v);
          }
        }
      } else {
        for (let i = 0; i < pos.count; i++) {
          verts.push(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(toLocal));
        }
      }

      // For each planar face cluster, project vertices onto its plane and cluster for multi-hole
      for (const planarFeature of planarFeatures) {
        if (planarFeature.partId !== partId) continue;
        const normal = new THREE.Vector3(...planarFeature.pose.localAxis);
        const planeOrigin = new THREE.Vector3(...planarFeature.pose.localPosition);

        // Compute face half-diagonal for outer boundary check
        const faceArea = planarFeature.dimensions.area ?? 0;
        const faceHalfDiag = Math.sqrt(faceArea) * 0.7071; // sqrt(area) / sqrt(2)

        const u = stableTangent(normal);
        const v = new THREE.Vector3().crossVectors(normal, u).normalize();
        const planeD = normal.dot(planeOrigin);

        // Project vertices near this plane
        const tol = (planarFeature.dimensions.tolerance ?? 0.001) * 2;
        const projPoints: Array<[number, number]> = [];
        for (const vert of verts) {
          const dist = Math.abs(vert.dot(normal) - planeD);
          if (dist > tol) continue;
          const rel = vert.clone().sub(planeOrigin);
          projPoints.push([rel.dot(u), rel.dot(v)]);
        }

        if (projPoints.length < 6) continue;

        // Grid-cluster the projected points (bucket size = 5mm)
        const BUCKET_SIZE = 0.005;
        const clusters2d = gridCluster2D(projPoints, BUCKET_SIZE);

        for (const clusterPts of clusters2d) {
          if (clusterPts.length < 6) continue;

          const fit = fitCircleToPoints2D(clusterPts);
          if (!fit) continue;

          // Validate radius in [3mm, 40mm]
          if (fit.r < 0.003 || fit.r > 0.04) continue;

          // Reject residual > 15%
          if (fit.residual > 0.15) continue;

          // Filter outer boundary: skip if radius > 70% of face half-diagonal
          if (faceHalfDiag > 0 && fit.r > faceHalfDiag * 0.7) continue;

          // Confidence based on inlier ratio
          const confidence = Math.max(0, fit.inlierRatio * (1 - fit.residual * 3));

          // Circle center in part-local space
          const circleCenterLocal = planeOrigin.clone()
            .addScaledVector(u, fit.cx)
            .addScaledVector(v, fit.cy);

          const localPos: [number, number, number] = [circleCenterLocal.x, circleCenterLocal.y, circleCenterLocal.z];
          const localAxis: [number, number, number] = [normal.x, normal.y, normal.z];

          const holeDims: FeatureDimensions = {
            diameter: fit.r * 2,
            depth: null, // treat as through-hole
            tolerance: Math.max(0.0005, fit.r * 0.1),
          };

          const holeFeature: AssemblyFeature = {
            id: crypto.randomUUID(),
            type: 'cylindrical_hole',
            partId,
            pose: { localPosition: localPos, localAxis },
            dimensions: holeDims,
            semanticRole: 'receive',
            supportFaceNormal: planarFeature.pose.localAxis,
            confidence,
            label: `hole d=${(fit.r * 2 * 1000).toFixed(1)}mm`,
            extractedBy: 'circle_fit',
          };
          features.push(holeFeature);
        }
      }
    });

    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractCircleHoleFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — Orientation-agnostic peg detection
// ---------------------------------------------------------------------------

/**
 * Stage 3: Detect cylindrical peg/pin protrusions from any support face.
 *
 * Does not assume world-up. For each planar face, looks for vertices that
 * protrude outward beyond the face plane, clusters them in 2D, and circle-fits.
 */
export function extractPegFeatures(
  obj: THREE.Object3D,
  partId: string,
  planarFeatures: AssemblyFeature[]
): AssemblyFeature[] {
  try {
    if (planarFeatures.length === 0) return [];
    const features: AssemblyFeature[] = [];

    obj.updateWorldMatrix(true, true);

    // Collect all part-local vertices
    const allVerts = collectVerticesLocal(obj);
    if (allVerts.length === 0) return features;

    // For each planar face (support face candidate)
    for (const supportFace of planarFeatures) {
      // Only use large faces as support candidates (area > 1cm²)
      const faceArea = supportFace.dimensions.area ?? 0;
      if (faceArea < 0.0001) continue;

      const supportNormal = new THREE.Vector3(...supportFace.pose.localAxis);
      const supportOrigin = new THREE.Vector3(...supportFace.pose.localPosition);
      const supportD = supportNormal.dot(supportOrigin);
      const supportArea = faceArea;

      // Vertices that protrude "outward" beyond this face plane
      const aboveVerts = allVerts.filter(v => v.dot(supportNormal) > supportD + 1e-4);
      if (aboveVerts.length < 5) continue;

      // Build 2D frame on support plane
      const u = stableTangent(supportNormal);
      const v = new THREE.Vector3().crossVectors(supportNormal, u).normalize();

      // Project above-plane vertices to 2D
      const projAbove: Array<[number, number, number]> = aboveVerts.map(vert => {
        const rel = vert.clone().sub(supportOrigin);
        return [rel.dot(u), rel.dot(v), vert.dot(supportNormal) - supportD];
      });

      // Grid-cluster the projected points (bucket size proportional to face)
      const CLUSTER_RADIUS = Math.sqrt(supportArea) * 0.15;
      const BUCKET_SIZE = Math.max(0.002, CLUSTER_RADIUS * 0.3);
      const pts2d: Array<[number, number]> = projAbove.map(([pu, pv]) => [pu, pv]);
      const clusters2d = gridCluster2D(pts2d, BUCKET_SIZE);

      for (const clusterPts of clusters2d) {
        if (clusterPts.length < 5) continue;

        const fit = fitCircleToPoints2D(clusterPts);
        if (!fit) continue;
        if (fit.residual > 0.25) continue;
        if (fit.r < 0.001 || fit.r > 0.02) continue; // 1mm–20mm
        // Peg must be smaller than support face
        if (supportArea > 0 && fit.r * fit.r * Math.PI > supportArea * 0.5) continue;

        // Compute max height of peg cluster above support plane
        let maxHeight = 0;
        for (const [pu, pv] of clusterPts) {
          // Find the original 3D height for these projected points
          // Match by proximity to the fit center
          const distFromCenter = Math.sqrt((pu - fit.cx) ** 2 + (pv - fit.cy) ** 2);
          if (distFromCenter < fit.r * 1.2) {
            // Find corresponding 3D point height
            for (const [p3u, p3v, p3h] of projAbove) {
              if (Math.abs(p3u - pu) < 1e-9 && Math.abs(p3v - pv) < 1e-9) {
                if (p3h > maxHeight) maxHeight = p3h;
              }
            }
          }
        }
        // Fallback: use all cluster heights
        if (maxHeight < 1e-5) {
          for (const [pu, pv] of clusterPts) {
            for (const [p3u, p3v, p3h] of projAbove) {
              if (Math.abs(p3u - pu) < 1e-6 && Math.abs(p3v - pv) < 1e-6) {
                if (p3h > maxHeight) maxHeight = p3h;
              }
            }
          }
        }

        // Peg center in part-local space (base of peg on support plane + halfway up)
        const pegBase = supportOrigin.clone()
          .addScaledVector(u, fit.cx)
          .addScaledVector(v, fit.cy);
        const pegCenter = pegBase.clone().addScaledVector(supportNormal, maxHeight * 0.5);

        const localPos: [number, number, number] = [pegCenter.x, pegCenter.y, pegCenter.z];
        const localAxis: [number, number, number] = [supportNormal.x, supportNormal.y, supportNormal.z];

        const pegDims: FeatureDimensions = {
          diameter: fit.r * 2,
          depth: maxHeight > 1e-5 ? maxHeight : undefined,
          tolerance: Math.max(0.0005, fit.r * 0.1),
        };

        const pegFeature: AssemblyFeature = {
          id: crypto.randomUUID(),
          type: 'peg',
          partId,
          pose: { localPosition: localPos, localAxis },
          dimensions: pegDims,
          semanticRole: 'insert',
          supportFaceNormal: supportFace.pose.localAxis,
          confidence: Math.max(0, fit.inlierRatio * 0.7 * (1 - fit.residual * 3)),
          label: `peg d=${(fit.r * 2 * 1000).toFixed(1)}mm h=${(maxHeight * 1000).toFixed(1)}mm`,
          extractedBy: 'peg_detect',
        };
        features.push(pegFeature);
      }
    }

    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractPegFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — Slot detection via 2D PCA
// ---------------------------------------------------------------------------

/**
 * Stage 4: Detect rectangular slot features on planar faces.
 *
 * For each planar cluster, projects to 2D, runs 2D PCA to find elongated
 * sub-regions, then emits slot features for groups with aspect ratio > 2.5.
 */
export function extractSlotFeatures(
  obj: THREE.Object3D,
  partId: string,
  planarFeatures: AssemblyFeature[]
): AssemblyFeature[] {
  try {
    const features: AssemblyFeature[] = [];
    obj.updateWorldMatrix(true, true);
    const worldInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();

    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;

      const geom = mesh.geometry as THREE.BufferGeometry;
      const pos = geom.attributes.position;
      if (!pos) return;

      mesh.updateWorldMatrix(false, false);
      const toLocal = new THREE.Matrix4().copy(worldInv).multiply(mesh.matrixWorld);

      // Build unique vertex list in part-local space
      const verts: THREE.Vector3[] = [];
      const idx = geom.index;
      if (idx) {
        const seen = new Set<number>();
        for (let i = 0; i < idx.count; i++) {
          const vi = idx.getX(i);
          if (!seen.has(vi)) {
            seen.add(vi);
            verts.push(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, vi).applyMatrix4(toLocal));
          }
        }
      } else {
        for (let i = 0; i < pos.count; i++) {
          verts.push(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(toLocal));
        }
      }

      for (const planarFeature of planarFeatures) {
        if (planarFeature.partId !== partId) continue;
        const normal = new THREE.Vector3(...planarFeature.pose.localAxis);
        const planeOrigin = new THREE.Vector3(...planarFeature.pose.localPosition);

        const { points: projPoints, u: uVec, v: vVec } = projectToPlaneWithBasis(
          verts, normal, planeOrigin,
          (planarFeature.dimensions.tolerance ?? 0.001) * 2
        );

        if (projPoints.length < 6) continue;

        // Use PCA to find overall principal axis
        const pcaResult = pca2D(projPoints);
        const aspectRatio = pcaResult.lambda2 > 1e-12
          ? Math.sqrt(pcaResult.lambda1 / pcaResult.lambda2)
          : 1;

        // Only process if overall shape is elongated enough
        if (aspectRatio < 2.0) continue;

        // Project all points onto principal axis to get length/width
        const { axis1, axis2, centroid } = pcaResult;

        let minL = Infinity, maxL = -Infinity, minW = Infinity, maxW = -Infinity;
        for (const [px, py] of projPoints) {
          const dx = px - centroid[0], dy = py - centroid[1];
          const l = dx * axis1[0] + dy * axis1[1];
          const w = dx * axis2[0] + dy * axis2[1];
          if (l < minL) minL = l;
          if (l > maxL) maxL = l;
          if (w < minW) minW = w;
          if (w > maxW) maxW = w;
        }

        const length = maxL - minL;
        const width = maxW - minW;

        if (length < 0.005 || width < 0.001) continue;
        if (length / Math.max(width, 1e-9) < 2.0) continue;

        // Slot center in 3D
        const cx2d = centroid[0];
        const cy2d = centroid[1];
        const slotCenter3d = planeOrigin.clone()
          .addScaledVector(uVec, cx2d)
          .addScaledVector(vVec, cy2d);

        // Long axis in 3D
        const longAxis3d = uVec.clone().multiplyScalar(axis1[0])
          .addScaledVector(vVec, axis1[1]).normalize();

        // Depth estimate: look for opposing face or use width * 0.5
        const depth = width * 0.5;

        const localPos: [number, number, number] = [slotCenter3d.x, slotCenter3d.y, slotCenter3d.z];
        const localAxis: [number, number, number] = [normal.x, normal.y, normal.z];
        const localSecondaryAxis: [number, number, number] = [longAxis3d.x, longAxis3d.y, longAxis3d.z];

        const slotDims: FeatureDimensions = {
          length,
          width,
          depth,
          tolerance: Math.max(0.0005, width * 0.05),
        };

        const slotFeature: AssemblyFeature = {
          id: crypto.randomUUID(),
          type: 'slot',
          partId,
          pose: { localPosition: localPos, localAxis, localSecondaryAxis },
          dimensions: slotDims,
          semanticRole: 'receive',
          supportFaceNormal: planarFeature.pose.localAxis,
          confidence: Math.min(0.7, (aspectRatio - 2.0) / 5.0 * 0.5 + 0.2),
          label: `slot ${(length * 1000).toFixed(1)}×${(width * 1000).toFixed(1)}mm`,
          extractedBy: 'slot_detect',
        };
        features.push(slotFeature);
      }
    });

    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractSlotFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — Feature deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate near-identical features within the same type.
 *
 * Merge rules:
 * - planar_face: center distance < 10mm AND normal dot > 0.97 AND area within 20%
 * - cylindrical_hole: center distance < 3mm AND axis dot > 0.97 AND diameter within 15%
 * - peg: same as cylindrical_hole
 *
 * Keeps the highest-confidence feature from each merge group.
 */
export function deduplicateFeatures(features: AssemblyFeature[]): AssemblyFeature[] {
  const result: AssemblyFeature[] = [];
  const removed = new Set<string>();

  for (let i = 0; i < features.length; i++) {
    if (removed.has(features[i].id)) continue;
    const fi = features[i];
    let best = fi;

    for (let j = i + 1; j < features.length; j++) {
      if (removed.has(features[j].id)) continue;
      const fj = features[j];

      if (fi.type !== fj.type) continue;

      const centerI = new THREE.Vector3(...fi.pose.localPosition);
      const centerJ = new THREE.Vector3(...fj.pose.localPosition);
      const centerDist = centerI.distanceTo(centerJ);

      const axisI = new THREE.Vector3(...fi.pose.localAxis).normalize();
      const axisJ = new THREE.Vector3(...fj.pose.localAxis).normalize();
      const axisDot = Math.abs(axisI.dot(axisJ));

      if (fi.type === 'planar_face') {
        const areaI = fi.dimensions.area ?? 0;
        const areaJ = fj.dimensions.area ?? 0;
        const areaRatio = areaI > 0 && areaJ > 0
          ? Math.min(areaI, areaJ) / Math.max(areaI, areaJ)
          : 0;
        if (centerDist < 0.01 && axisDot > 0.97 && areaRatio > 0.8) {
          removed.add(fj.id);
          if (fj.confidence > best.confidence) best = fj;
        }
      } else if (fi.type === 'cylindrical_hole' || fi.type === 'peg' || fi.type === 'blind_hole') {
        const diamI = fi.dimensions.diameter ?? 0;
        const diamJ = fj.dimensions.diameter ?? 0;
        const diamRatio = diamI > 0 && diamJ > 0
          ? Math.min(diamI, diamJ) / Math.max(diamI, diamJ)
          : 0;
        if (centerDist < 0.003 && axisDot > 0.97 && diamRatio > 0.85) {
          removed.add(fj.id);
          if (fj.confidence > best.confidence) best = fj;
        }
      }
    }

    result.push(best);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract all assembly features from a THREE.Object3D.
 *
 * This is the primary public API for the feature extraction pipeline.
 * Returns an empty array rather than throwing on any error.
 *
 * @param obj - The Three.js object representing a part (mesh or group)
 * @param partId - The part's UUID in the application store
 * @returns AssemblyFeature[] sorted by confidence descending
 */
export function extractFeatures(
  obj: THREE.Object3D,
  partId: string
): AssemblyFeature[] {
  try {
    // Stage 1: planar faces
    const planarFeatures = extractPlanarFaceFeatures(obj, partId);

    // Stage 2: multi-hole detection on planar faces
    const holeFeatures = extractCircleHoleFeatures(obj, partId, planarFeatures);

    // Stage 3: orientation-agnostic peg detection
    const pegFeatures = extractPegFeatures(obj, partId, planarFeatures);

    // Stage 4: slot detection via 2D PCA
    const slotFeatures = extractSlotFeatures(obj, partId, planarFeatures);

    const all: AssemblyFeature[] = [
      ...planarFeatures,
      ...holeFeatures,
      ...pegFeatures,
      ...slotFeatures,
    ];

    // Stage 5: deduplication
    const deduped = deduplicateFeatures(all);

    // Sort by confidence descending so callers see highest-confidence features first
    deduped.sort((a, b) => b.confidence - a.confidence);

    return deduped;
  } catch (err) {
    console.warn('[featureExtractor] extractFeatures failed:', err);
    return [];
  }
}
