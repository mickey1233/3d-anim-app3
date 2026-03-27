/**
 * featureExtractor.ts — Multi-stage assembly feature extraction pipeline.
 *
 * Analyzes a THREE.Object3D and returns AssemblyFeature[] describing the
 * semantic assembly features present on the part (planar faces, holes, pegs, etc.).
 *
 * Pipeline stages (each independently exportable / replaceable):
 *   1. extractPlanarFaceFeatures — wraps clusterPlanarFaces, emits 'planar_face'
 *   2. extractCircleHoleFeatures — circle-fit on boundary loops, emits 'cylindrical_hole'
 *   3. extractPegFeatures        — cylindrical protrusion detection, emits 'peg'
 *   4. extractSlotFeatures       — stub placeholder for slot detection
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
 * TODO(v3-geometry): improve with part-level context (e.g. part name hints).
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

// ---------------------------------------------------------------------------
// Stage 1 — Planar face features
// ---------------------------------------------------------------------------

/**
 * Extract planar face features from a single THREE.Mesh using clusterPlanarFaces.
 *
 * TODO(v3-geometry): improve heuristic — currently only processes the first mesh found.
 * For multi-mesh Groups, faces are processed per-mesh in local mesh space, then the
 * cluster centers are approximated to part local space. A future version should merge
 * all meshes into a single geometry before clustering.
 */
function extractPlanarFacesFromMesh(
  mesh: THREE.Mesh,
  partId: string,
  worldInv: THREE.Matrix4
): AssemblyFeature[] {
  const features: AssemblyFeature[] = [];
  const geom = mesh.geometry as THREE.BufferGeometry | undefined;
  if (!geom) return features;

  // Transform mesh vertices to part-local space for cluster center and normal
  mesh.updateWorldMatrix(false, false);
  const toLocal = new THREE.Matrix4().copy(worldInv).multiply(mesh.matrixWorld);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(toLocal);

  const clusters: FaceCluster[] = clusterPlanarFaces(geom);

  for (const cluster of clusters) {
    // TODO(v3-geometry): area threshold is empirical — large models need higher threshold
    if (cluster.area < 1e-6) continue;

    // Transform cluster center and normal to part local space
    const centerLocal = cluster.center.clone().applyMatrix4(toLocal);
    const normalLocal = cluster.normal.clone().applyMatrix3(normalMatrix).normalize();

    const localPos: [number, number, number] = [centerLocal.x, centerLocal.y, centerLocal.z];
    const localAxis: [number, number, number] = [normalLocal.x, normalLocal.y, normalLocal.z];
    const tangent = stableTangent(normalLocal);
    const localSecondaryAxis: [number, number, number] = [tangent.x, tangent.y, tangent.z];

    const pose: FeaturePose = { localPosition: localPos, localAxis, localSecondaryAxis };
    const dims: FeatureDimensions = {
      area: cluster.area,
      // TODO(v3-geometry): tolerance is a rough 1% of sqrt(area), not calibrated
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
      confidence: Math.min(1, cluster.area * 1000), // rough confidence from area
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

    // Deduplicate near-identical clusters (same normal + plane within epsilon)
    // TODO(v3-geometry): improve dedup — currently keeps all, may produce duplicates for
    // multi-mesh groups where the same face appears on adjacent meshes.
    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractPlanarFaceFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — Circle / hole detection
// ---------------------------------------------------------------------------

/**
 * Detect circular boundary loops in a mesh geometry and return their centers + radii.
 *
 * Algorithm:
 * 1. Find all edges that appear exactly once (boundary edges of open meshes) or
 *    all edges shared between co-planar faces (internal pocket loops).
 * 2. For clusters of edges that form a closed loop, attempt a least-squares circle fit.
 *
 * TODO(v3-geometry): improve heuristic — currently uses a simplified approach that
 * finds vertices projected onto each planar cluster and fits circles to the outermost
 * ring. True boundary loop extraction requires half-edge traversal.
 */
function fitCircleToPoints2D(
  points: Array<[number, number]>
): { cx: number; cy: number; r: number; residual: number } | null {
  if (points.length < 3) return null;

  // Algebraic least squares circle fit: (x-cx)² + (y-cy)² = r²
  // Linearized: x² + y² = 2cx·x + 2cy·y + (r² - cx² - cy²)
  // => Ax + By + C = x² + y² where A=2cx, B=2cy, C=r²-cx²-cy²
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  let sxxx = 0, sxxy = 0, sxyy = 0, syyy = 0;
  const n = points.length;

  for (const [x, y] of points) {
    sx += x; sy += y;
    sxx += x * x; sxy += x * y; syy += y * y;
    sxxx += x * x * x; sxxy += x * x * y; sxyy += x * y * y; syyy += y * y * y;
  }

  // Build and solve 3×3 linear system (Pratt method simplified)
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
  for (const [x, y] of points) sumErr += Math.abs(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r);
  const residual = sumErr / n / r; // normalized residual

  return { cx, cy, r, residual };
}

/**
 * Stage 2: Extract cylindrical hole features from planar clusters by fitting circles
 * to the ring of vertices on the cluster plane.
 *
 * TODO(v3-geometry): improve heuristic — currently assumes circular holes lie on planar
 * faces and projects all cluster-plane vertices onto 2D. This catches most drilled holes
 * but will miss holes at angles or partially-hidden holes. True hole detection needs
 * topological edge loop analysis.
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

      // Build vertex list in part-local space
      const verts: THREE.Vector3[] = [];
      const idx = geom.index;
      if (idx) {
        // Unique vertices only
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

      // For each planar face cluster, project vertices onto its plane and fit circles
      for (const planarFeature of planarFeatures) {
        if (planarFeature.partId !== partId) continue;
        const normal = new THREE.Vector3(...planarFeature.pose.localAxis);
        const planeOrigin = new THREE.Vector3(...planarFeature.pose.localPosition);
        const planeD = normal.dot(planeOrigin);

        // Build 2D frame on the plane
        const u = stableTangent(normal);
        const v = new THREE.Vector3().crossVectors(normal, u).normalize();

        // Project vertices that lie near this plane (within 2× tolerance)
        const tol = (planarFeature.dimensions.tolerance ?? 0.001) * 2;
        const projPoints: Array<[number, number]> = [];
        for (const vert of verts) {
          const dist = Math.abs(vert.dot(normal) - planeD);
          if (dist > tol) continue;
          const rel = vert.clone().sub(planeOrigin);
          projPoints.push([rel.dot(u), rel.dot(v)]);
        }

        if (projPoints.length < 8) continue;

        // TODO(v3-geometry): improve clustering — currently fits one circle to all plane
        // vertices, which only works when the plane has exactly one circular hole and
        // no other geometry. Multi-hole faces need k-means or RANSAC clustering.

        // Attempt circle fit
        const fit = fitCircleToPoints2D(projPoints);
        if (!fit) continue;

        // Quality check: residual should be small (<20%) and circle shouldn't be huge
        if (fit.residual > 0.2) continue;
        if (fit.r < 1e-4) continue; // too small
        if (planarFeature.dimensions.area !== undefined && fit.r * fit.r * Math.PI > planarFeature.dimensions.area * 2) continue;

        // Circle center in part-local space
        const circleCenterLocal = planeOrigin.clone()
          .addScaledVector(u, fit.cx)
          .addScaledVector(v, fit.cy);

        const localPos: [number, number, number] = [circleCenterLocal.x, circleCenterLocal.y, circleCenterLocal.z];
        const localAxis: [number, number, number] = [normal.x, normal.y, normal.z];

        const holeDims: FeatureDimensions = {
          diameter: fit.r * 2,
          depth: null, // unknown — treat as through-hole
          // TODO(v3-geometry): tolerance calibration needed — using 5% of diameter
          tolerance: fit.r * 0.1,
        };

        const holeFeature: AssemblyFeature = {
          id: crypto.randomUUID(),
          type: 'cylindrical_hole',
          partId,
          pose: {
            localPosition: localPos,
            localAxis,
          },
          dimensions: holeDims,
          semanticRole: 'receive',
          supportFaceNormal: planarFeature.pose.localAxis,
          confidence: Math.max(0, 1 - fit.residual * 4),
          label: `hole d=${(fit.r * 2 * 1000).toFixed(1)}mm`,
          extractedBy: 'circle_fit',
        };
        features.push(holeFeature);
      }
    });

    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractCircleHoleFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — Peg detection
// ---------------------------------------------------------------------------

/**
 * Stage 3: Detect cylindrical peg/pin protrusions above the main support plane.
 *
 * Algorithm:
 * 1. Find the dominant support plane (largest planar_face feature whose normal is
 *    roughly world-up, i.e. the "top" of the part).
 * 2. Find circular clusters of vertices that are ABOVE this plane — these are peg tops.
 * 3. For each such cluster, fit a circle and check that the circle is smaller than the
 *    support plane, indicating a protrusion rather than the whole face.
 *
 * TODO(v3-geometry): improve heuristic — currently assumes pegs protrude along the Y
 * axis in world space. Parts with pegs on non-Y faces (e.g. side connectors) will be
 * missed. A proper implementation should detect cylinders using Hough transform or
 * RANSAC on the mesh normals.
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
    const worldInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();

    // Find the largest planar face with roughly upward-pointing normal
    // TODO(v3-geometry): this uses a 0.7 dot threshold which works for most parts
    // but may select the wrong face for parts tilted > 45° from vertical.
    const upward = new THREE.Vector3(0, 1, 0);
    const supportFaces = planarFeatures
      .filter(f => {
        const n = new THREE.Vector3(...f.pose.localAxis);
        const worldN = n.clone().transformDirection(obj.matrixWorld).normalize();
        return worldN.dot(upward) > 0.7;
      })
      .sort((a, b) => (b.dimensions.area ?? 0) - (a.dimensions.area ?? 0));

    if (supportFaces.length === 0) return [];
    const supportFace = supportFaces[0];
    const supportNormal = new THREE.Vector3(...supportFace.pose.localAxis);
    const supportOrigin = new THREE.Vector3(...supportFace.pose.localPosition);
    const supportD = supportNormal.dot(supportOrigin);
    const supportArea = supportFace.dimensions.area ?? 0;

    // Collect all part-local vertices above the support plane
    const allVerts = collectVerticesLocal(obj);
    const aboveVerts = allVerts.filter(v => v.dot(supportNormal) > supportD + 1e-4);
    if (aboveVerts.length < 5) return [];

    // Build 2D frame on support plane to cluster above-plane vertices
    const u = stableTangent(supportNormal);
    const v = new THREE.Vector3().crossVectors(supportNormal, u).normalize();

    const projAbove: Array<[number, number, number]> = aboveVerts.map(vert => {
      const rel = vert.clone().sub(supportOrigin);
      return [rel.dot(u), rel.dot(v), vert.dot(supportNormal) - supportD];
    });

    // Simple spatial clustering: group projected points within 2× average peg radius
    // TODO(v3-geometry): replace naive O(n²) clustering with a grid or k-means approach
    const CLUSTER_RADIUS = Math.sqrt(supportArea) * 0.15;
    const clusters: Array<{ points: Array<[number, number]>; maxHeight: number }> = [];

    for (const [pu, pv, ph] of projAbove) {
      let assigned = false;
      for (const cluster of clusters) {
        // Cluster centroid
        const cu = cluster.points.reduce((s, p) => s + p[0], 0) / cluster.points.length;
        const cv = cluster.points.reduce((s, p) => s + p[1], 0) / cluster.points.length;
        const dist = Math.sqrt((pu - cu) ** 2 + (pv - cv) ** 2);
        if (dist < CLUSTER_RADIUS) {
          cluster.points.push([pu, pv]);
          if (ph > cluster.maxHeight) cluster.maxHeight = ph;
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        clusters.push({ points: [[pu, pv]], maxHeight: ph });
      }
    }

    for (const cluster of clusters) {
      if (cluster.points.length < 5) continue;

      const fit = fitCircleToPoints2D(cluster.points);
      if (!fit) continue;
      if (fit.residual > 0.25) continue; // not circular enough
      if (fit.r < 1e-4) continue;
      // Peg must be smaller than support face
      if (supportArea > 0 && fit.r * fit.r * Math.PI > supportArea * 0.5) continue;

      // Peg center in part-local space
      const pegCenter = supportOrigin.clone()
        .addScaledVector(u, fit.cx)
        .addScaledVector(v, fit.cy)
        .addScaledVector(supportNormal, cluster.maxHeight * 0.5);

      const localPos: [number, number, number] = [pegCenter.x, pegCenter.y, pegCenter.z];
      const localAxis: [number, number, number] = [supportNormal.x, supportNormal.y, supportNormal.z];

      const pegDims: FeatureDimensions = {
        diameter: fit.r * 2,
        depth: cluster.maxHeight,
        // TODO(v3-geometry): tolerance calibration — using 5% of diameter
        tolerance: fit.r * 0.1,
      };

      const pegFeature: AssemblyFeature = {
        id: crypto.randomUUID(),
        type: 'peg',
        partId,
        pose: {
          localPosition: localPos,
          localAxis,
        },
        dimensions: pegDims,
        semanticRole: 'insert',
        supportFaceNormal: supportFace.pose.localAxis,
        confidence: Math.max(0, 0.7 * (1 - fit.residual * 3)),
        label: `peg d=${(fit.r * 2 * 1000).toFixed(1)}mm h=${(cluster.maxHeight * 1000).toFixed(1)}mm`,
        extractedBy: 'peg_detect',
      };
      features.push(pegFeature);
    }

    return features;
  } catch (err) {
    console.warn('[featureExtractor] extractPegFeatures failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — Slot detection (stub)
// ---------------------------------------------------------------------------

/**
 * Stage 4: Detect rectangular slot features.
 *
 * TODO(v3-geometry): implement slot detection — currently returns empty array.
 * A slot can be detected by finding pairs of parallel edges on a planar cluster
 * that are separated by a consistent width and have open ends.
 * Implementation requires: edge extraction → parallel pair matching → width/depth measurement.
 */
export function extractSlotFeatures(
  _obj: THREE.Object3D,
  _partId: string,
  _planarFeatures: AssemblyFeature[]
): AssemblyFeature[] {
  // TODO(v3-geometry): implement slot detection
  return [];
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

    // Stage 2: circle/hole detection on planar faces
    const holeFeatures = extractCircleHoleFeatures(obj, partId, planarFeatures);

    // Stage 3: peg detection
    const pegFeatures = extractPegFeatures(obj, partId, planarFeatures);

    // Stage 4: slot detection (stub)
    const slotFeatures = extractSlotFeatures(obj, partId, planarFeatures);

    const all: AssemblyFeature[] = [
      ...planarFeatures,
      ...holeFeatures,
      ...pegFeatures,
      ...slotFeatures,
    ];

    // Sort by confidence descending so callers see highest-confidence features first
    all.sort((a, b) => b.confidence - a.confidence);

    return all;
  } catch (err) {
    console.warn('[featureExtractor] extractFeatures failed:', err);
    return [];
  }
}
