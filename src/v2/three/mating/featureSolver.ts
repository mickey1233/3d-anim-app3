/**
 * featureSolver.ts — Rigid transform solver for feature-based assembly.
 *
 * Given a set of matched FeaturePair[] and the Two Object3Ds, computes the rigid
 * transform (translation + rotation) to apply to the source part so that its
 * features align with the target features.
 *
 * Solver methods:
 *  - plane_align  : single planar_face pair — align normals anti-parallel, translate
 *  - peg_slot     : single peg↔hole pair — align axes, translate center-to-center
 *  - point_align  : two planar_face pairs — translation + rotation around normal
 *  - axis_align   : general axis alignment
 *  - socket_insert: tab↔slot or socket↔edge_connector
 *  - pattern_align: ≥2 matched hole/peg pairs — Kabsch SVD rigid alignment
 *
 * Backward compat: does not modify solveMateTopBottom or any existing solver paths.
 *
 * AlignmentSolution.solutionType is ALWAYS 'absolute_world':
 *   translation = absolute world position for source part after alignment (NOT delta)
 *   rotation    = absolute world quaternion for source part after alignment (NOT delta)
 */

import * as THREE from 'three';
import type {
  AlignmentSolution,
  AssemblyFeature,
  FeaturePair,
  MatingCandidate,
} from './featureTypes';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stableTangent(n: THREE.Vector3): THREE.Vector3 {
  const up = Math.abs(n.dot(new THREE.Vector3(0, 1, 0))) > 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(up, n).normalize();
}

/** Convert THREE.Quaternion to [x, y, z, w] tuple. */
function quatToTuple(q: THREE.Quaternion): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

/** Convert THREE.Vector3 to [x, y, z] tuple. */
function vec3ToTuple(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

/**
 * Get the world-space position of a feature's origin.
 * Prefers the cached worldPosition, falls back to applying the object's matrixWorld.
 */
function featureWorldPosition(
  feature: AssemblyFeature,
  obj: THREE.Object3D
): THREE.Vector3 {
  if (feature.pose.worldPosition) {
    return new THREE.Vector3(...feature.pose.worldPosition);
  }
  obj.updateWorldMatrix(true, false);
  return new THREE.Vector3(...feature.pose.localPosition).applyMatrix4(obj.matrixWorld);
}

/**
 * Get the world-space primary axis of a feature.
 * Prefers the cached worldAxis, falls back to transforming localAxis.
 */
function featureWorldAxis(
  feature: AssemblyFeature,
  obj: THREE.Object3D
): THREE.Vector3 {
  if (feature.pose.worldAxis) {
    return new THREE.Vector3(...feature.pose.worldAxis).normalize();
  }
  obj.updateWorldMatrix(true, false);
  return new THREE.Vector3(...feature.pose.localAxis)
    .transformDirection(obj.matrixWorld)
    .normalize();
}

// ---------------------------------------------------------------------------
// 3×3 matrix utilities for Kabsch SVD
// ---------------------------------------------------------------------------

/** 3×3 matrix as flat row-major array [a00,a01,a02, a10,a11,a12, a20,a21,a22] */
type Mat3 = [number,number,number, number,number,number, number,number,number];

function mat3Identity(): Mat3 { return [1,0,0, 0,1,0, 0,0,1]; }

function mat3Transpose(A: Mat3): Mat3 {
  return [A[0],A[3],A[6], A[1],A[4],A[7], A[2],A[5],A[8]];
}

function mat3Mul(A: Mat3, B: Mat3): Mat3 {
  const C = mat3Identity();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i*3+j] = A[i*3+0]*B[0*3+j] + A[i*3+1]*B[1*3+j] + A[i*3+2]*B[2*3+j];
    }
  }
  return C;
}

function mat3Det(A: Mat3): number {
  return A[0]*(A[4]*A[8]-A[5]*A[7]) - A[1]*(A[3]*A[8]-A[5]*A[6]) + A[2]*(A[3]*A[7]-A[4]*A[6]);
}

/**
 * Computes SVD of 3×3 matrix A via Jacobi eigendecomposition of A^T A.
 * Returns U, S (singular values), V such that A ≈ U * diag(S) * V^T.
 * Uses 50 Jacobi iterations — reliable for 3×3.
 */
function svd3x3Sym(A: Mat3): { U: Mat3; S: [number,number,number]; V: Mat3 } {
  // Compute B = A^T A (symmetric)
  const At = mat3Transpose(A);
  const B = mat3Mul(At, A);

  // Jacobi for symmetric B → eigenvalues/vectors
  let J: Mat3 = mat3Identity();
  let Bc: Mat3 = [...B] as Mat3;

  for (let iter = 0; iter < 50; iter++) {
    // Find off-diagonal element with largest absolute value
    let p = 0, q = 1;
    let maxVal = Math.abs(Bc[1]);
    if (Math.abs(Bc[2]) > maxVal) { p = 0; q = 2; maxVal = Math.abs(Bc[2]); }
    if (Math.abs(Bc[5]) > maxVal) { p = 1; q = 2; }

    if (Math.abs(Bc[p*3+q]) < 1e-12) break;

    const bpp = Bc[p*3+p];
    const bqq = Bc[q*3+q];
    const bpq = Bc[p*3+q];
    const theta = 0.5 * Math.atan2(2*bpq, bqq - bpp);
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // Givens rotation matrix G
    const G: Mat3 = mat3Identity();
    G[p*3+p] = c; G[p*3+q] = -s;
    G[q*3+p] = s; G[q*3+q] = c;

    const Gt = mat3Transpose(G);
    Bc = mat3Mul(mat3Mul(Gt, Bc), G);
    J = mat3Mul(J, G);
  }

  const S: [number,number,number] = [
    Math.sqrt(Math.max(0, Bc[0])),
    Math.sqrt(Math.max(0, Bc[4])),
    Math.sqrt(Math.max(0, Bc[8])),
  ];
  const V = J;

  // U = A V S^{-1} (for non-zero singular values)
  const Sinv: Mat3 = [
    S[0] > 1e-10 ? 1/S[0] : 0, 0, 0,
    0, S[1] > 1e-10 ? 1/S[1] : 0, 0,
    0, 0, S[2] > 1e-10 ? 1/S[2] : 0,
  ];
  const U = mat3Mul(mat3Mul(A, V), Sinv);

  return { U, S, V };
}

/**
 * Kabsch algorithm: finds optimal rotation + translation to align source points
 * to target points.
 *
 * Returns rotation (quaternion) and translation (world-space delta).
 * This is the ONLY correct way to solve multi-point rigid alignment.
 */
function kabschSolve(
  srcPts: THREE.Vector3[],
  tgtPts: THREE.Vector3[]
): { rotation: THREE.Quaternion; translation: THREE.Vector3; residualError: number } | null {
  if (srcPts.length < 2 || srcPts.length !== tgtPts.length) return null;

  // Centroids
  const srcC = srcPts.reduce((a, b) => a.clone().add(b), new THREE.Vector3())
    .divideScalar(srcPts.length);
  const tgtC = tgtPts.reduce((a, b) => a.clone().add(b), new THREE.Vector3())
    .divideScalar(tgtPts.length);

  // Centered points
  const H = srcPts.map(p => p.clone().sub(srcC));
  const B = tgtPts.map(p => p.clone().sub(tgtC));

  // Cross-covariance M = H^T B (3×3 matrix)
  const M: Mat3 = [0,0,0, 0,0,0, 0,0,0];
  for (let k = 0; k < H.length; k++) {
    const hArr = [H[k].x, H[k].y, H[k].z];
    const bArr = [B[k].x, B[k].y, B[k].z];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        M[i*3+j] += hArr[i] * bArr[j];
      }
    }
  }

  const { U, V } = svd3x3Sym(M);

  // Handle reflection: d = sign(det(V * U^T))
  const VUt = mat3Mul(V, mat3Transpose(U));
  const d = mat3Det(VUt) >= 0 ? 1 : -1;
  const D: Mat3 = [1,0,0, 0,1,0, 0,0,d];
  const R = mat3Mul(mat3Mul(V, D), mat3Transpose(U));

  // Build rotation matrix and quaternion
  const m4 = new THREE.Matrix4();
  m4.set(
    R[0], R[1], R[2], 0,
    R[3], R[4], R[5], 0,
    R[6], R[7], R[8], 0,
    0,    0,    0,    1
  );
  const rotation = new THREE.Quaternion().setFromRotationMatrix(m4);

  // Translation: t = tgtCentroid - R * srcCentroid
  const rotatedSrcC = new THREE.Vector3(
    R[0]*srcC.x + R[1]*srcC.y + R[2]*srcC.z,
    R[3]*srcC.x + R[4]*srcC.y + R[5]*srcC.z,
    R[6]*srcC.x + R[7]*srcC.y + R[8]*srcC.z
  );
  const translation = tgtC.clone().sub(rotatedSrcC);

  // Residual: RMSE after alignment
  const rotMatrix = new THREE.Matrix3();
  rotMatrix.set(R[0],R[1],R[2], R[3],R[4],R[5], R[6],R[7],R[8]);
  let residual = 0;
  for (let k = 0; k < srcPts.length; k++) {
    const rp = srcPts[k].clone().applyMatrix3(rotMatrix).add(translation);
    residual += rp.distanceToSquared(tgtPts[k]);
  }
  residual = Math.sqrt(residual / srcPts.length);

  return { rotation, translation, residualError: residual };
}

// ---------------------------------------------------------------------------
// Solver: single planar face pair
// ---------------------------------------------------------------------------

/**
 * Solve: align source planar face normal anti-parallel to target planar face normal,
 * then translate so that the source face touches the target face.
 *
 * The rotation is around the cross-product of the two normals (if they are not already
 * anti-parallel). If they are already anti-parallel, only translation is needed.
 *
 * TODO(v3-geometry): improve — this solver leaves the in-plane position unconstrained.
 * A proper planar mate should also constrain lateral position (requires second pair or
 * a centroid-matching heuristic).
 */
function solvePlanePair(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  pair: FeaturePair
): AlignmentSolution | null {
  sourceObj.updateWorldMatrix(true, false);
  targetObj.updateWorldMatrix(true, false);

  const srcNormalWorld = featureWorldAxis(pair.sourceFeature, sourceObj);
  const tgtNormalWorld = featureWorldAxis(pair.targetFeature, targetObj);

  const srcCenterWorld = featureWorldPosition(pair.sourceFeature, sourceObj);
  const tgtCenterWorld = featureWorldPosition(pair.targetFeature, targetObj);

  // Target facing: we want srcNormal to become anti-parallel to tgtNormal.
  // i.e. after rotation: srcNormal' = -tgtNormal
  const targetFacing = tgtNormalWorld.clone().negate();
  const rotation = new THREE.Quaternion().setFromUnitVectors(srcNormalWorld, targetFacing);

  // Rotate the source center and compute translation
  const srcWorldPos = new THREE.Vector3();
  sourceObj.getWorldPosition(srcWorldPos);

  const rotatedSrcCenter = srcCenterWorld.clone()
    .sub(srcWorldPos)
    .applyQuaternion(rotation)
    .add(srcWorldPos);

  const translation = tgtCenterWorld.clone().sub(rotatedSrcCenter);

  // Residual: how well do face normals align after rotation?
  const srcNormalAfter = srcNormalWorld.clone().applyQuaternion(rotation);
  const residualDot = srcNormalAfter.dot(targetFacing); // 1.0 = perfect
  const residualError = Math.abs(1 - residualDot) * 0.01; // convert to meters-ish

  // Approach direction = -tgtNormal (source approaches from above)
  const approachDirection = tgtNormalWorld.clone().negate();

  return {
    translation: vec3ToTuple(translation),
    rotation: quatToTuple(rotation),
    solutionType: 'absolute_world',
    approachDirection: vec3ToTuple(approachDirection),
    usedPairs: [pair],
    method: 'plane_align',
    residualError,
    diagnostics: [
      `plane_align: srcNormal=(${srcNormalWorld.toArray().map(n => n.toFixed(3)).join(',')})`,
      `tgtNormal=(${tgtNormalWorld.toArray().map(n => n.toFixed(3)).join(',')})`,
      `residualDot=${residualDot.toFixed(4)}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Solver: peg into hole
// ---------------------------------------------------------------------------

/**
 * Solve: align peg axis anti-parallel to hole axis, translate peg tip to hole opening.
 *
 * The peg TIP aligns with the hole opening (not peg center to hole center).
 * Offset = half peg depth toward insertion direction.
 */
function solvePegHolePair(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  pair: FeaturePair,
  pegIsSource: boolean
): AlignmentSolution | null {
  sourceObj.updateWorldMatrix(true, false);
  targetObj.updateWorldMatrix(true, false);

  const pegFeature = pegIsSource ? pair.sourceFeature : pair.targetFeature;
  const holeFeature = pegIsSource ? pair.targetFeature : pair.sourceFeature;
  const pegObj = pegIsSource ? sourceObj : targetObj;
  const holeObj = pegIsSource ? targetObj : sourceObj;
  // Note: we always apply transform to sourceObj
  const applyToSource = pegIsSource;

  const pegAxisWorld = featureWorldAxis(pegFeature, pegObj);
  const holeAxisWorld = featureWorldAxis(holeFeature, holeObj);

  const pegCenterWorld = featureWorldPosition(pegFeature, pegObj);
  const holeCenterWorld = featureWorldPosition(holeFeature, holeObj);

  // Peg axis should be anti-parallel to hole axis (peg points into hole)
  const targetPegAxis = holeAxisWorld.clone().negate();
  const rotation = new THREE.Quaternion().setFromUnitVectors(pegAxisWorld, targetPegAxis);

  // Compute peg insertion depth offset: move peg so tip (not center) aligns with hole opening
  // depth = peg height (how far it protrudes); offset peg center by depth/2 toward insertion
  const pegDepth = pegFeature.dimensions.depth ?? pegFeature.dimensions.diameter ?? 0;
  const insertionOffset = pegDepth * 0.5;

  // Apply rotation to peg center and compute translation
  const srcWorldPos = new THREE.Vector3();
  sourceObj.getWorldPosition(srcWorldPos);

  const rotatedPegCenter = pegCenterWorld.clone()
    .sub(srcWorldPos)
    .applyQuaternion(applyToSource ? rotation : new THREE.Quaternion())
    .add(srcWorldPos);

  // The peg tip is at rotatedPegCenter + pegAxis_rotated * insertionOffset
  // We want the tip to align with hole center, so:
  // rotatedPegCenter + insertionOffset * (-holeAxis) = holeCenterWorld
  // => translation = holeCenterWorld - insertionOffset * (-holeAxis) - rotatedPegCenter
  const pegAxisAfterRotation = pegAxisWorld.clone()
    .applyQuaternion(applyToSource ? rotation : new THREE.Quaternion())
    .normalize();
  const tipOffset = pegAxisAfterRotation.clone().multiplyScalar(insertionOffset);

  const translation = holeCenterWorld.clone()
    .sub(rotatedPegCenter)
    .sub(tipOffset);

  // Residual: how well do diameters match?
  const pegDiam = pegFeature.dimensions.diameter ?? 0;
  const holeDiam = holeFeature.dimensions.diameter ?? 0;
  const diameterResidual = holeDiam > 0 ? Math.abs(pegDiam - holeDiam) : 0;

  // Approach direction = peg's local axis (direction the source moves toward target)
  const approachDirection = holeAxisWorld.clone().negate();

  return {
    translation: vec3ToTuple(translation),
    rotation: quatToTuple(applyToSource ? rotation : new THREE.Quaternion()),
    solutionType: 'absolute_world',
    approachDirection: vec3ToTuple(approachDirection),
    usedPairs: [pair],
    method: 'peg_slot',
    residualError: diameterResidual,
    diagnostics: [
      `peg_slot: pegDiam=${(pegDiam * 1000).toFixed(2)}mm holeDiam=${(holeDiam * 1000).toFixed(2)}mm`,
      `pegDepth=${(pegDepth * 1000).toFixed(2)}mm insertionOffset=${(insertionOffset * 1000).toFixed(2)}mm`,
      `diameterResidual=${(diameterResidual * 1000).toFixed(3)}mm`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Solver: two-point alignment (two feature pairs)
// ---------------------------------------------------------------------------

/**
 * Solve from two feature pairs: constrains both translation and in-plane rotation.
 *
 * Method:
 * 1. Solve primary pair (plane_align or peg_slot) to get primary rotation + translation.
 * 2. After applying primary solution, compute residual in-plane rotation needed to
 *    align secondary pair centers.
 *
 * TODO(v3-geometry): this is a greedy sequential approach, not a proper simultaneous
 * least-squares solution. For more than 2 pairs, a proper SVD-based solver is needed.
 */
function solveTwoPairAlignment(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  primaryPair: FeaturePair,
  secondaryPair: FeaturePair
): AlignmentSolution | null {
  // First solve the primary pair
  const primarySolution = solveSinglePair(sourceObj, targetObj, primaryPair);
  if (!primarySolution) return null;

  // Apply primary transform to a scratch copy to compute secondary residual
  const scratchSource = sourceObj.clone(false);
  scratchSource.position.setFromMatrixPosition(sourceObj.matrixWorld);
  scratchSource.quaternion.setFromRotationMatrix(sourceObj.matrixWorld);
  scratchSource.updateMatrixWorld(true);

  // Apply primary rotation + translation to scratch
  const primaryRot = new THREE.Quaternion(...primarySolution.rotation);
  const primaryTrans = new THREE.Vector3(...primarySolution.translation);
  scratchSource.applyQuaternion(primaryRot);
  scratchSource.position.add(primaryTrans);
  scratchSource.updateMatrixWorld(true);

  // Now compute the in-plane rotation needed to align secondary pair
  const secSrcCenterWorld = featureWorldPosition(secondaryPair.sourceFeature, scratchSource);
  const secTgtCenterWorld = featureWorldPosition(secondaryPair.targetFeature, targetObj);

  // Project both centers onto the primary face plane (perpendicular to the face normal)
  const primaryNormal = new THREE.Vector3(...primarySolution.approachDirection).negate().normalize();

  const srcRel = secSrcCenterWorld.clone().sub(new THREE.Vector3(...primarySolution.translation));
  const tgtRel = secTgtCenterWorld.clone();

  // Project to plane perpendicular to approach
  const srcProj = srcRel.clone().sub(primaryNormal.clone().multiplyScalar(srcRel.dot(primaryNormal)));
  const tgtProj = tgtRel.clone().sub(primaryNormal.clone().multiplyScalar(tgtRel.dot(primaryNormal)));

  if (srcProj.lengthSq() < 1e-10 || tgtProj.lengthSq() < 1e-10) {
    // Secondary constraint can't add rotation — return primary only
    return {
      ...primarySolution,
      usedPairs: [primaryPair, secondaryPair],
      diagnostics: [
        ...primarySolution.diagnostics,
        'secondary pair degenerate — using primary solution only',
      ],
    };
  }

  // Rotation around primary axis to align projected secondary centers
  const inPlaneRotation = new THREE.Quaternion().setFromUnitVectors(
    srcProj.clone().normalize(),
    tgtProj.clone().normalize()
  );

  // Combine rotations: first primary, then in-plane
  const combinedRotation = inPlaneRotation.clone().multiply(primaryRot);

  // Recompute translation with combined rotation
  const srcWorldPos = new THREE.Vector3();
  sourceObj.getWorldPosition(srcWorldPos);
  const srcCenter = featureWorldPosition(primaryPair.sourceFeature, sourceObj);
  const tgtCenter = featureWorldPosition(primaryPair.targetFeature, targetObj);

  const rotatedSrcCenter = srcCenter.clone()
    .sub(srcWorldPos)
    .applyQuaternion(combinedRotation)
    .add(srcWorldPos);

  const combinedTranslation = tgtCenter.clone().sub(rotatedSrcCenter);

  // Residual: distance between secondary pair centers after combined transform
  const secSrcAfter = featureWorldPosition(secondaryPair.sourceFeature, sourceObj)
    .sub(srcWorldPos)
    .applyQuaternion(combinedRotation)
    .add(srcWorldPos)
    .add(combinedTranslation);
  const residualError = secSrcAfter.distanceTo(secTgtCenterWorld);

  return {
    translation: vec3ToTuple(combinedTranslation),
    rotation: quatToTuple(combinedRotation),
    solutionType: 'absolute_world',
    approachDirection: primarySolution.approachDirection,
    usedPairs: [primaryPair, secondaryPair],
    method: 'point_align',
    residualError,
    diagnostics: [
      ...primarySolution.diagnostics,
      `two-pair: secondary residual=${(residualError * 1000).toFixed(2)}mm`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Single-pair dispatcher
// ---------------------------------------------------------------------------

/**
 * Solve a single feature pair, dispatching to the appropriate sub-solver.
 */
function solveSinglePair(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  pair: FeaturePair
): AlignmentSolution | null {
  const srcType = pair.sourceFeature.type;
  const tgtType = pair.targetFeature.type;

  // Planar face pair
  if (
    (srcType === 'planar_face' || srcType === 'support_pad') &&
    (tgtType === 'planar_face' || tgtType === 'support_pad')
  ) {
    return solvePlanePair(sourceObj, targetObj, pair);
  }

  // Peg ↔ hole
  if (srcType === 'peg' && (tgtType === 'cylindrical_hole' || tgtType === 'blind_hole')) {
    return solvePegHolePair(sourceObj, targetObj, pair, true);
  }
  if ((srcType === 'cylindrical_hole' || srcType === 'blind_hole') && tgtType === 'peg') {
    return solvePegHolePair(sourceObj, targetObj, pair, false);
  }

  // Tab ↔ slot: treat like peg↔hole for alignment purposes
  // TODO(v3-geometry): implement proper tab-slot solver with width/length constraints
  if (srcType === 'tab' && tgtType === 'slot') {
    return solvePegHolePair(sourceObj, targetObj, pair, true);
  }
  if (srcType === 'slot' && tgtType === 'tab') {
    return solvePegHolePair(sourceObj, targetObj, pair, false);
  }

  // Socket ↔ edge connector: treat like axis alignment
  if (
    (srcType === 'socket' || srcType === 'edge_connector') &&
    (tgtType === 'socket' || tgtType === 'edge_connector')
  ) {
    return solvePlanePair(sourceObj, targetObj, pair);
  }

  // Generic fallback: use axis alignment
  return solveGenericAxisAlign(sourceObj, targetObj, pair);
}

/**
 * Generic axis-alignment solver.
 * Aligns source feature axis to be anti-parallel to target feature axis,
 * and translates source center to target center.
 */
function solveGenericAxisAlign(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  pair: FeaturePair
): AlignmentSolution | null {
  try {
    sourceObj.updateWorldMatrix(true, false);
    targetObj.updateWorldMatrix(true, false);

    const srcAxisWorld = featureWorldAxis(pair.sourceFeature, sourceObj);
    const tgtAxisWorld = featureWorldAxis(pair.targetFeature, targetObj);
    const targetSrcAxis = tgtAxisWorld.clone().negate();

    const rotation = new THREE.Quaternion().setFromUnitVectors(srcAxisWorld, targetSrcAxis);

    const srcCenterWorld = featureWorldPosition(pair.sourceFeature, sourceObj);
    const tgtCenterWorld = featureWorldPosition(pair.targetFeature, targetObj);

    const srcWorldPos = new THREE.Vector3();
    sourceObj.getWorldPosition(srcWorldPos);

    const rotatedSrcCenter = srcCenterWorld.clone()
      .sub(srcWorldPos)
      .applyQuaternion(rotation)
      .add(srcWorldPos);

    const translation = tgtCenterWorld.clone().sub(rotatedSrcCenter);

    return {
      translation: vec3ToTuple(translation),
      rotation: quatToTuple(rotation),
      solutionType: 'absolute_world',
      approachDirection: vec3ToTuple(tgtAxisWorld.clone().negate()),
      usedPairs: [pair],
      method: 'axis_align',
      residualError: 0,
      diagnostics: [`axis_align fallback for ${pair.sourceFeature.type} ↔ ${pair.targetFeature.type}`],
    };
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Solver: pattern alignment (Kabsch SVD, ≥2 matched pairs)
// ---------------------------------------------------------------------------

/**
 * Solve multi-point rigid alignment using the Kabsch algorithm.
 *
 * Takes ≥2 matched feature pairs (e.g. peg↔hole pairs in a bolt-circle pattern)
 * and finds the optimal rotation + translation to align source to target.
 *
 * Falls back to single-pair solve if Kabsch fails or < 2 valid pairs.
 */
function solvePatternAlign(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  featurePairs: FeaturePair[]
): AlignmentSolution | null {
  sourceObj.updateWorldMatrix(true, true);
  targetObj.updateWorldMatrix(true, true);

  const srcPts: THREE.Vector3[] = [];
  const tgtPts: THREE.Vector3[] = [];
  const diagnostics: string[] = [];

  for (const pair of featurePairs) {
    const sf = pair.sourceFeature;
    const tf = pair.targetFeature;
    // Get world positions (prefer cached worldPosition, fallback to local + matrixWorld)
    const srcWorld = sf.pose.worldPosition
      ? new THREE.Vector3(...sf.pose.worldPosition)
      : new THREE.Vector3(...sf.pose.localPosition).applyMatrix4(sourceObj.matrixWorld);
    const tgtWorld = tf.pose.worldPosition
      ? new THREE.Vector3(...tf.pose.worldPosition)
      : new THREE.Vector3(...tf.pose.localPosition).applyMatrix4(targetObj.matrixWorld);
    srcPts.push(srcWorld);
    tgtPts.push(tgtWorld);
  }

  if (srcPts.length < 2) {
    diagnostics.push('pattern_align fallback: < 2 pairs, using primary-pair solve');
    const fallback = solveSinglePair(sourceObj, targetObj, featurePairs[0]);
    if (fallback) {
      return { ...fallback, diagnostics: [...fallback.diagnostics, ...diagnostics] };
    }
    return null;
  }

  const result = kabschSolve(srcPts, tgtPts);
  if (!result) {
    diagnostics.push('Kabsch solve failed — falling back to primary pair');
    const fallback = solveSinglePair(sourceObj, targetObj, featurePairs[0]);
    if (fallback) {
      return { ...fallback, diagnostics: [...fallback.diagnostics, ...diagnostics] };
    }
    return null;
  }

  // Apply solved rotation + translation to source world position to get new world position.
  // The Kabsch result: R rotates source feature cloud to align with target feature cloud,
  // and T = tgtCentroid - R * srcCentroid gives the world-space delta.
  // New world position of source = R * srcWorldPos + T
  const srcWorldPos = new THREE.Vector3();
  sourceObj.getWorldPosition(srcWorldPos);

  const rotMatrix = new THREE.Matrix3();
  const rotQ = result.rotation;
  // Convert quaternion to rotation matrix elements
  const m4tmp = new THREE.Matrix4();
  m4tmp.makeRotationFromQuaternion(rotQ);
  rotMatrix.setFromMatrix4(m4tmp);
  const newWorldPos = srcWorldPos.clone().applyMatrix3(rotMatrix).add(result.translation);

  // Convert new world position to parent-local space
  const parent = sourceObj.parent;
  let newLocalPos: THREE.Vector3;
  if (parent) {
    const parentWorldInv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    newLocalPos = newWorldPos.clone().applyMatrix4(parentWorldInv);
  } else {
    newLocalPos = newWorldPos;
  }

  // Compute new world quaternion: newWorldQuat = R * srcWorldQuat
  const srcWorldQuat = new THREE.Quaternion();
  sourceObj.getWorldQuaternion(srcWorldQuat);
  const newWorldQuat = rotQ.clone().multiply(srcWorldQuat);

  // Convert to parent-local quaternion
  let newLocalQuat: THREE.Quaternion;
  if (parent) {
    const parentWorldQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuat);
    newLocalQuat = parentWorldQuat.clone().invert().multiply(newWorldQuat);
  } else {
    newLocalQuat = newWorldQuat;
  }

  // Approach direction = mean of (targetPt - srcPt) directions
  const approach = new THREE.Vector3();
  for (let i = 0; i < srcPts.length; i++) {
    approach.add(tgtPts[i].clone().sub(srcPts[i]));
  }
  approach.divideScalar(srcPts.length).normalize();

  diagnostics.push(
    `pattern_align: used ${featurePairs.length} pairs, residual=${result.residualError.toFixed(4)}m`
  );
  if (result.residualError > 0.005) {
    diagnostics.push(`WARNING: high residual error ${result.residualError.toFixed(4)}m`);
  }

  return {
    translation: [newLocalPos.x, newLocalPos.y, newLocalPos.z],
    rotation: [newLocalQuat.x, newLocalQuat.y, newLocalQuat.z, newLocalQuat.w],
    solutionType: 'absolute_world',
    approachDirection: [approach.x, approach.y, approach.z],
    usedPairs: featurePairs,
    method: 'pattern_align',
    residualError: result.residualError,
    patternPairCount: featurePairs.length,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Insertion feasibility heuristic
// ---------------------------------------------------------------------------

/**
 * Estimate how feasible the insertion is, including a simple bbox collision check.
 *
 * Returns feasibility [0–1], collisionPenalty [0–1], and diagnostic notes.
 */
export function estimateInsertionFeasibility(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  featurePair: FeaturePair,
  solution: AlignmentSolution
): { feasibility: number; collisionPenalty: number; notes: string[] } {
  const notes: string[] = [];

  try {
    sourceObj.updateWorldMatrix(true, true);
    targetObj.updateWorldMatrix(true, true);

    // Compute world-space bounding boxes
    const srcBox = new THREE.Box3().setFromObject(sourceObj);
    const tgtBox = new THREE.Box3().setFromObject(targetObj);

    // Apply solution translation to source bbox
    const trans = new THREE.Vector3(...solution.translation);
    const solvedSrcBox = srcBox.clone().translate(trans);

    // Check overlap with target bbox
    const intersects = solvedSrcBox.intersectsBox(tgtBox);

    if (intersects) {
      // Compute overlap volume
      const overlapBox = solvedSrcBox.clone().intersect(tgtBox);
      const overlapSize = new THREE.Vector3();
      overlapBox.getSize(overlapSize);
      const overlapVol = overlapSize.x * overlapSize.y * overlapSize.z;

      const srcSize = new THREE.Vector3();
      solvedSrcBox.getSize(srcSize);
      const srcVol = srcSize.x * srcSize.y * srcSize.z;

      const overlapRatio = srcVol > 0 ? overlapVol / srcVol : 0;

      if (overlapRatio > 0.1) {
        // Source is significantly inside target — likely wrong
        const penalty = Math.min(1, overlapRatio * 2);
        notes.push(`bbox overlap ratio=${overlapRatio.toFixed(2)} → collision penalty=${penalty.toFixed(2)}`);
        return { feasibility: 1 - penalty, collisionPenalty: penalty, notes };
      }
      notes.push(`minor bbox overlap ratio=${overlapRatio.toFixed(3)} — accepted`);
    }

    // Peg-hole specific: check radius compatibility
    const srcType = featurePair.sourceFeature.type;
    const tgtType = featurePair.targetFeature.type;
    if (
      (srcType === 'peg' && (tgtType === 'cylindrical_hole' || tgtType === 'blind_hole')) ||
      ((srcType === 'cylindrical_hole' || srcType === 'blind_hole') && tgtType === 'peg')
    ) {
      const pegFeature = srcType === 'peg' ? featurePair.sourceFeature : featurePair.targetFeature;
      const holeFeature = srcType === 'peg' ? featurePair.targetFeature : featurePair.sourceFeature;
      const pegR = (pegFeature.dimensions.diameter ?? 0) / 2;
      const holeR = (holeFeature.dimensions.diameter ?? 0) / 2;
      const tolerance = Math.max(holeFeature.dimensions.tolerance, pegFeature.dimensions.tolerance);

      if (pegR > holeR + tolerance) {
        const oversize = pegR - holeR;
        const penalty = Math.min(1, oversize / Math.max(tolerance, 0.0001) * 0.5);
        notes.push(`peg (r=${(pegR * 1000).toFixed(1)}mm) too large for hole (r=${(holeR * 1000).toFixed(1)}mm) → penalty=${penalty.toFixed(2)}`);
        return { feasibility: 1 - penalty, collisionPenalty: penalty, notes };
      }
      notes.push(`peg-hole radius OK: peg=${(pegR * 1000).toFixed(1)}mm hole=${(holeR * 1000).toFixed(1)}mm`);
    }

    // Planar faces: always feasible (no insertion collision)
    if (srcType === 'planar_face' && tgtType === 'planar_face') {
      return { feasibility: 1.0, collisionPenalty: 0, notes: ['planar_face pair — always feasible'] };
    }

    return { feasibility: 1.0, collisionPenalty: 0, notes };
  } catch (err) {
    notes.push(`feasibility check failed: ${String(err)}`);
    return { feasibility: 0.5, collisionPenalty: 0, notes };
  }
}

/**
 * Solve the rigid transform that aligns source to target using the provided feature pairs.
 *
 * @param sourceObj - The Three.js object for the source part (will be moved)
 * @param targetObj - The Three.js object for the target part (stays fixed)
 * @param featurePairs - Feature pairs from featureMatcher.generateMatingCandidates()
 * @param method - Solver method override ('auto' = dispatch based on feature types)
 * @returns AlignmentSolution or null if solving fails
 *
 * NOTE: AlignmentSolution.solutionType is always 'absolute_world'. The translation and
 * rotation fields represent absolute world pose for the source part, NOT a delta.
 */
export function solveAlignment(
  sourceObj: THREE.Object3D,
  targetObj: THREE.Object3D,
  featurePairs: FeaturePair[],
  method?: 'auto' | 'axis_align' | 'point_align' | 'plane_align' | 'pattern_align'
): AlignmentSolution | null {
  if (featurePairs.length === 0) return null;

  try {
    sourceObj.updateWorldMatrix(true, false);
    targetObj.updateWorldMatrix(true, false);

    const effectiveMethod = method ?? 'auto';

    // pattern_align: use Kabsch SVD when ≥2 pairs are provided
    if (effectiveMethod === 'pattern_align') {
      return solvePatternAlign(sourceObj, targetObj, featurePairs);
    }

    // Auto dispatch: use pattern_align for multi-pair peg/hole combos
    if (effectiveMethod === 'auto' && featurePairs.length >= 2) {
      const allPegHole = featurePairs.every(p => {
        const st = p.sourceFeature.type;
        const tt = p.targetFeature.type;
        return (
          (st === 'peg' && (tt === 'cylindrical_hole' || tt === 'blind_hole')) ||
          ((st === 'cylindrical_hole' || st === 'blind_hole') && tt === 'peg') ||
          (st === 'cylindrical_hole' && tt === 'cylindrical_hole')
        );
      });
      if (allPegHole) {
        return solvePatternAlign(sourceObj, targetObj, featurePairs);
      }
      // Try two-pair alignment for better constraint (mixed types)
      const solution = solveTwoPairAlignment(
        sourceObj,
        targetObj,
        featurePairs[0],
        featurePairs[1]
      );
      if (solution) return solution;
    }

    // Auto dispatch for single pair or plane_align
    if (effectiveMethod === 'auto' || effectiveMethod === 'plane_align') {
      if (featurePairs.length >= 2) {
        // Try two-pair alignment for better constraint
        const solution = solveTwoPairAlignment(
          sourceObj,
          targetObj,
          featurePairs[0],
          featurePairs[1]
        );
        if (solution) return solution;
      }
      // Fall through to single-pair
      return solveSinglePair(sourceObj, targetObj, featurePairs[0]);
    }

    if (effectiveMethod === 'point_align' && featurePairs.length >= 2) {
      return solveTwoPairAlignment(sourceObj, targetObj, featurePairs[0], featurePairs[1]);
    }

    if (effectiveMethod === 'axis_align') {
      return solveGenericAxisAlign(sourceObj, targetObj, featurePairs[0]);
    }

    // Default fallback
    return solveSinglePair(sourceObj, targetObj, featurePairs[0]);
  } catch (err) {
    console.warn('[featureSolver] solveAlignment failed:', err);
    return null;
  }
}
