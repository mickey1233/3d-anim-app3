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
 *
 * Backward compat: does not modify solveMateTopBottom or any existing solver paths.
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
  const pegAxisAfterRotation = pegAxisWorld.clone().applyQuaternion(applyToSource ? rotation : new THREE.Quaternion()).normalize();
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

    // Auto dispatch
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

    // pattern_align: TODO(v3-geometry): implement for bolt-circle patterns
    if (effectiveMethod === 'pattern_align') {
      console.warn('[featureSolver] pattern_align not yet implemented, falling back to single-pair');
      return solveSinglePair(sourceObj, targetObj, featurePairs[0]);
    }

    // Default fallback
    return solveSinglePair(sourceObj, targetObj, featurePairs[0]);
  } catch (err) {
    console.warn('[featureSolver] solveAlignment failed:', err);
    return null;
  }
}
