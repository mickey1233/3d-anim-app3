/**
 * featureMatcher.ts — Feature pairing and candidate generation for assembly inference.
 *
 * Given AssemblyFeature[] for a source part and a target part, this module:
 *   1. Enumerates all compatible feature pairs (type + semantic role + dimension compatibility).
 *   2. Scores each pair on multiple dimensions.
 *   3. Groups pairs into MatingCandidate hypotheses.
 *   4. Returns candidates sorted by totalScore descending.
 *
 * Backward compat: nothing here replaces solveMateTopBottom or resolveAnchor.
 */

import * as THREE from 'three';
import type {
  AssemblyFeature,
  FeaturePair,
  MatingCandidate,
  SemanticRole,
  FeatureType,
} from './featureTypes';
import { solveAlignment, estimateInsertionFeasibility } from './featureSolver';

// ---------------------------------------------------------------------------
// Feature type compatibility table
// ---------------------------------------------------------------------------

/**
 * Returns 0–1 type compatibility score for a source/target feature type pair.
 *
 * Rules:
 * - Perfect match (complementary pairs): peg↔hole, tab↔slot, socket↔edge_connector
 * - Compatible but not ideal: planar_face↔planar_face, support↔support
 * - Anything involving 'unknown' type: 0.3 (uncertain but possible)
 * - Incompatible: 0.0
 *
 * TODO(v3-geometry): extend table as more feature types are implemented.
 */
function typeCompatibilityScore(srcType: FeatureType, tgtType: FeatureType): number {
  // Perfect complementary pairs
  if (
    (srcType === 'peg' && (tgtType === 'cylindrical_hole' || tgtType === 'blind_hole')) ||
    ((srcType === 'cylindrical_hole' || srcType === 'blind_hole') && tgtType === 'peg')
  ) return 1.0;

  if (
    (srcType === 'tab' && tgtType === 'slot') ||
    (srcType === 'slot' && tgtType === 'tab')
  ) return 1.0;

  if (
    (srcType === 'socket' && tgtType === 'edge_connector') ||
    (srcType === 'edge_connector' && tgtType === 'socket')
  ) return 1.0;

  // Same-type pairings
  if (srcType === 'planar_face' && tgtType === 'planar_face') return 0.9;
  if (srcType === 'support_pad' && tgtType === 'planar_face') return 0.7;
  if (srcType === 'planar_face' && tgtType === 'support_pad') return 0.7;
  if (srcType === 'support_pad' && tgtType === 'support_pad') return 0.6;
  if (srcType === 'rail' && tgtType === 'slot') return 0.8;
  if (srcType === 'slot' && tgtType === 'rail') return 0.8;
  if (srcType === 'edge_notch' && tgtType === 'edge_notch') return 0.6;

  // Hole-to-hole (alignment via shared axis, possible)
  if (
    (srcType === 'cylindrical_hole' || srcType === 'blind_hole') &&
    (tgtType === 'cylindrical_hole' || tgtType === 'blind_hole')
  ) return 0.4;

  // Anything with unknown/peg-peg is very low score
  if (srcType === 'peg' && tgtType === 'peg') return 0.1;

  // All other combinations: incompatible
  return 0.0;
}

/**
 * Returns 0–1 semantic role compatibility score.
 *
 * insert↔receive is the ideal pairing.
 * support↔support is OK for flat mating.
 * align↔align is OK for guide rails.
 * Anything else scores lower.
 */
function roleCompatibilityScore(srcRole: SemanticRole, tgtRole: SemanticRole): number {
  if (srcRole === 'insert' && tgtRole === 'receive') return 1.0;
  if (srcRole === 'receive' && tgtRole === 'insert') return 1.0;
  if (srcRole === 'support' && tgtRole === 'support') return 0.9;
  if (srcRole === 'align' && tgtRole === 'align') return 0.8;
  if (srcRole === 'fasten' && tgtRole === 'fasten') return 0.7;
  if (srcRole === 'seal' && tgtRole === 'seal') return 0.7;
  // unknown pairs with anything at reduced score
  if (srcRole === 'unknown' || tgtRole === 'unknown') return 0.4;
  // Mismatched but not impossible
  return 0.2;
}

// ---------------------------------------------------------------------------
// Dimension fit scoring
// ---------------------------------------------------------------------------

/**
 * Gaussian scoring around zero difference: score = exp(-0.5 * (delta/sigma)²)
 * Returns 0–1.
 */
function gaussianScore(delta: number, sigma: number): number {
  if (sigma <= 0) return delta === 0 ? 1 : 0;
  return Math.exp(-0.5 * (delta / sigma) ** 2);
}

/**
 * Score how well the dimensions of two features match.
 * Uses feature-type-specific dimension fields.
 *
 * TODO(v3-geometry): tolerance model is simplified — uses max(tol_src, tol_tgt)
 * as the sigma for the Gaussian. A proper model would use tolerance stack-up rules.
 */
function dimensionFitScore(src: AssemblyFeature, tgt: AssemblyFeature): number {
  const srcDims = src.dimensions;
  const tgtDims = tgt.dimensions;
  const sigma = Math.max(srcDims.tolerance, tgtDims.tolerance, 1e-6);

  const scores: number[] = [];

  // Diameter match (for peg↔hole, hole↔hole pairs)
  if (srcDims.diameter !== undefined && tgtDims.diameter !== undefined) {
    const delta = Math.abs(srcDims.diameter - tgtDims.diameter);
    scores.push(gaussianScore(delta, sigma * 2));
  }

  // Area match (for planar_face pairs) — within 50% is acceptable
  if (
    srcDims.area !== undefined && tgtDims.area !== undefined &&
    srcDims.area > 0 && tgtDims.area > 0
  ) {
    const ratio = Math.min(srcDims.area, tgtDims.area) / Math.max(srcDims.area, tgtDims.area);
    // Area can differ a lot in valid assemblies (partial overlap) — use sqrt ratio
    scores.push(Math.sqrt(ratio));
  }

  // Width match (for slot/tab pairs)
  if (srcDims.width !== undefined && tgtDims.width !== undefined) {
    const delta = Math.abs(srcDims.width - tgtDims.width);
    scores.push(gaussianScore(delta, sigma * 2));
  }

  // If no dimensional comparison was possible, return a neutral score
  if (scores.length === 0) return 0.5;
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

// ---------------------------------------------------------------------------
// Axis alignment scoring
// ---------------------------------------------------------------------------

/**
 * Score the geometric axis alignment between two features.
 * Uses world-space axes when available, falls back to local axes.
 *
 * Feature pair axis semantics:
 * - planar_face ↔ planar_face: normals must be ANTI-PARALLEL (faces face each other)
 * - peg ↔ hole: peg axis must be ANTI-PARALLEL to hole axis (peg goes in)
 * - hole ↔ hole: axes must be PARALLEL (co-axial)
 * - other: parallel is better (0.5 for perpendicular, 1.0 for parallel/anti-parallel)
 *
 * TODO(v3-geometry): world-axis comparison requires parts to be in their final assembly
 * position, which is unknown. Currently uses part-local axes only, which may produce
 * incorrect scores for rotated parts. A future version should use the current scene
 * transform from the Zustand store.
 */
function axisAlignmentScore(src: AssemblyFeature, tgt: AssemblyFeature): number {
  // Use world axes if available, else local
  const srcAxisArr = src.pose.worldAxis ?? src.pose.localAxis;
  const tgtAxisArr = tgt.pose.worldAxis ?? tgt.pose.localAxis;
  const srcAxis = new THREE.Vector3(...srcAxisArr).normalize();
  const tgtAxis = new THREE.Vector3(...tgtAxisArr).normalize();

  const dotProduct = srcAxis.dot(tgtAxis);
  const absDot = Math.abs(dotProduct);

  const srcType = src.type;
  const tgtType = tgt.type;

  // Faces must be anti-parallel (dot = -1)
  if (srcType === 'planar_face' || tgtType === 'planar_face' ||
      srcType === 'support_pad' || tgtType === 'support_pad') {
    // Score peaks at dot = -1 (anti-parallel), drops to 0 at dot = +1 (parallel/same direction)
    return Math.max(0, (-dotProduct + 1) / 2);
  }

  // Peg↔hole: peg axis anti-parallel to hole axis (peg points into hole)
  if (
    (srcType === 'peg' && (tgtType === 'cylindrical_hole' || tgtType === 'blind_hole')) ||
    ((srcType === 'cylindrical_hole' || srcType === 'blind_hole') && tgtType === 'peg')
  ) {
    return Math.max(0, (-dotProduct + 1) / 2);
  }

  // Co-axial holes: parallel axes preferred
  if (
    (srcType === 'cylindrical_hole' || srcType === 'blind_hole') &&
    (tgtType === 'cylindrical_hole' || tgtType === 'blind_hole')
  ) {
    return absDot;
  }

  // Default: prefer aligned axes
  return (absDot + 1) / 2;
}

// ---------------------------------------------------------------------------
// Face support consistency score
// ---------------------------------------------------------------------------

/**
 * Backward-compat scoring: reward pairs where source's bottom face would rest on
 * target's top face (the classic "place on top" assembly).
 *
 * This bridges the new feature system with the existing face-based heuristics.
 *
 * TODO(v3-geometry): this uses a hardcoded upward direction in part-local space,
 * which is wrong for parts with non-Y-up convention. Should use world-space up.
 */
function faceSupportConsistencyScore(src: AssemblyFeature, tgt: AssemblyFeature): number {
  const upward = new THREE.Vector3(0, 1, 0);

  const srcNormal = new THREE.Vector3(...(src.pose.worldAxis ?? src.pose.localAxis)).normalize();
  const tgtNormal = new THREE.Vector3(...(tgt.pose.worldAxis ?? tgt.pose.localAxis)).normalize();

  // Source bottom (facing down) ↔ target top (facing up) gets bonus
  const srcFacingDown = srcNormal.dot(upward) < -0.6;
  const tgtFacingUp = tgtNormal.dot(upward) > 0.6;

  if (srcFacingDown && tgtFacingUp) return 1.0;
  if (srcFacingDown || tgtFacingUp) return 0.5;
  return 0.3;
}

// ---------------------------------------------------------------------------
// Feature pair generation
// ---------------------------------------------------------------------------

/**
 * Generate all compatible feature pairs between source and target feature sets.
 * Returns pairs sorted by compatibilityScore descending.
 */
function generateFeaturePairs(
  sourceFeatures: AssemblyFeature[],
  targetFeatures: AssemblyFeature[],
  toleranceMultiplier: number,
  requireSemanticCompat: boolean
): FeaturePair[] {
  const pairs: FeaturePair[] = [];

  for (const src of sourceFeatures) {
    for (const tgt of targetFeatures) {
      // Skip if same part (shouldn't happen but guard anyway)
      if (src.partId === tgt.partId) continue;

      const typeScore = typeCompatibilityScore(src.type, tgt.type);
      if (typeScore <= 0) continue; // Incompatible types — skip entirely

      const roleScore = roleCompatibilityScore(src.semanticRole, tgt.semanticRole);
      if (requireSemanticCompat && roleScore < 0.3) continue;

      // Dimension check using combined tolerance window
      const srcTol = src.dimensions.tolerance * toleranceMultiplier;
      const tgtTol = tgt.dimensions.tolerance * toleranceMultiplier;
      const combinedTol = srcTol + tgtTol;

      // Quick dimensional gate: if diameter mismatch > combined tolerance, skip
      if (
        src.dimensions.diameter !== undefined &&
        tgt.dimensions.diameter !== undefined
      ) {
        const diameterDiff = Math.abs(src.dimensions.diameter - tgt.dimensions.diameter);
        if (diameterDiff > combinedTol && combinedTol > 0) continue;
      }

      const dimScore = dimensionFitScore(src, tgt);
      const axisScore = axisAlignmentScore(src, tgt);
      const supportScore = faceSupportConsistencyScore(src, tgt);

      // Overall compatibility: weighted combination
      // Weights: type (0.3) + role (0.1) + dimension (0.3) + axis (0.2) + support (0.1)
      const compatibilityScore =
        typeScore * 0.3 +
        roleScore * 0.1 +
        dimScore * 0.3 +
        axisScore * 0.2 +
        supportScore * 0.1;

      const notes: string[] = [];
      if (typeScore >= 0.9) notes.push(`perfect type match: ${src.type} ↔ ${tgt.type}`);
      if (dimScore < 0.3) notes.push(`dimension mismatch: src=${JSON.stringify(src.dimensions)} tgt=${JSON.stringify(tgt.dimensions)}`);
      if (axisScore > 0.8) notes.push('good axis alignment');
      if (axisScore < 0.3) notes.push('poor axis alignment');

      pairs.push({
        sourceFeature: src,
        targetFeature: tgt,
        compatibilityScore,
        dimensionFitScore: dimScore,
        axisAlignmentScore: axisScore,
        notes,
      });
    }
  }

  return pairs.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

/**
 * Build a human-readable description for a MatingCandidate.
 */
function buildCandidateDescription(
  pairs: FeaturePair[],
  sourcePartId: string,
  targetPartId: string
): string {
  if (pairs.length === 0) return `No feature pairs (${sourcePartId} → ${targetPartId})`;
  const primary = pairs[0];
  const srcLabel = primary.sourceFeature.label ?? primary.sourceFeature.type;
  const tgtLabel = primary.targetFeature.label ?? primary.targetFeature.type;
  if (pairs.length === 1) {
    return `${srcLabel} mates with ${tgtLabel}`;
  }
  return `${srcLabel} mates with ${tgtLabel} (+${pairs.length - 1} more pair${pairs.length > 2 ? 's' : ''})`;
}

/**
 * Generate MatingCandidate[] from source and target feature sets.
 * Returns candidates sorted by totalScore descending.
 *
 * @param sourceFeatures - Features extracted from the source part
 * @param targetFeatures - Features extracted from the target part
 * @param sourcePartId - UUID of the source part
 * @param targetPartId - UUID of the target part
 * @param options - Matching options
 * @param sourceObj - Optional Three.js object for source part (enables feasibility check)
 * @param targetObj - Optional Three.js object for target part (enables feasibility check)
 */
export function generateMatingCandidates(
  sourceFeatures: AssemblyFeature[],
  targetFeatures: AssemblyFeature[],
  sourcePartId: string,
  targetPartId: string,
  options?: {
    maxCandidates?: number;
    toleranceMultiplier?: number;
    requireSemanticCompat?: boolean;
  },
  sourceObj?: THREE.Object3D,
  targetObj?: THREE.Object3D
): MatingCandidate[] {
  const maxCandidates = options?.maxCandidates ?? 10;
  const toleranceMultiplier = options?.toleranceMultiplier ?? 2.0;
  const requireSemanticCompat = options?.requireSemanticCompat ?? false;

  if (sourceFeatures.length === 0 || targetFeatures.length === 0) {
    return [];
  }

  // Generate all compatible pairs
  const allPairs = generateFeaturePairs(
    sourceFeatures,
    targetFeatures,
    toleranceMultiplier,
    requireSemanticCompat
  );

  if (allPairs.length === 0) return [];

  // Strategy 1: Single-pair candidates (each top pair becomes a candidate)
  // Strategy 2: Multi-pair candidates (combine the top pair with additional constraints)
  // TODO(v3-geometry): implement pattern-based multi-pair matching (e.g. 4-hole bolt circle)

  const candidates: MatingCandidate[] = [];

  // Add top single-pair candidates
  const topPairs = allPairs.slice(0, maxCandidates * 2);
  const usedSrcIds = new Set<string>();
  const usedTgtIds = new Set<string>();

  for (const pair of topPairs) {
    if (candidates.length >= maxCandidates) break;

    const srcId = pair.sourceFeature.id;
    const tgtId = pair.targetFeature.id;

    // Avoid duplicate candidates using the same primary features
    const key = `${srcId}:${tgtId}`;
    if (usedSrcIds.has(srcId) && usedTgtIds.has(tgtId)) continue;

    usedSrcIds.add(srcId);
    usedTgtIds.add(tgtId);

    // Look for a compatible secondary pair that constrains rotation
    // (a secondary pair using different features from a different type)
    const secondaryPairs = allPairs.filter(p => {
      if (p === pair) return false;
      if (p.sourceFeature.id === srcId || p.targetFeature.id === tgtId) return false;
      // Secondary pair should be of a different type (e.g. planar + peg/hole)
      return p.sourceFeature.type !== pair.sourceFeature.type ||
             p.targetFeature.type !== pair.targetFeature.type;
    });

    const pairsForCandidate = secondaryPairs.length > 0
      ? [pair, secondaryPairs[0]]
      : [pair];

    // Compute score breakdown
    const avgTypeScore = pairsForCandidate.reduce(
      (s, p) => s + typeCompatibilityScore(p.sourceFeature.type, p.targetFeature.type), 0
    ) / pairsForCandidate.length;

    const avgDimScore = pairsForCandidate.reduce(
      (s, p) => s + p.dimensionFitScore, 0
    ) / pairsForCandidate.length;

    const avgAxisScore = pairsForCandidate.reduce(
      (s, p) => s + p.axisAlignmentScore, 0
    ) / pairsForCandidate.length;

    const faceSupportScore = pairsForCandidate.reduce(
      (s, p) => s + faceSupportConsistencyScore(p.sourceFeature, p.targetFeature), 0
    ) / pairsForCandidate.length;

    // Symmetry penalty: if the source type is planar_face on both ends,
    // add a small ambiguity penalty (many possible rotations around normal)
    const hasOnlyPlanarFaces = pairsForCandidate.every(
      p => p.sourceFeature.type === 'planar_face' && p.targetFeature.type === 'planar_face'
    );
    const symmetryPenalty = hasOnlyPlanarFaces ? 0.1 : 0.0;

    const totalScore = Math.max(0, Math.min(1,
      avgTypeScore * 0.25 +
      avgDimScore * 0.25 +
      avgAxisScore * 0.25 +
      faceSupportScore * 0.15 +
      pair.compatibilityScore * 0.10 -
      symmetryPenalty
    ));

    const diagnostics: string[] = [];
    if (secondaryPairs.length > 0) {
      diagnostics.push(`secondary constraint: ${secondaryPairs[0].sourceFeature.type} ↔ ${secondaryPairs[0].targetFeature.type}`);
    }
    if (hasOnlyPlanarFaces) {
      diagnostics.push('only planar face pairs — rotation around normal axis is ambiguous');
    }

    // Run solver + feasibility check if objects are provided
    let solvedTransform = undefined;
    let collisionPenalty = 0;
    let insertionFeasibility = 1.0;
    if (sourceObj && targetObj) {
      try {
        const solution = solveAlignment(sourceObj, targetObj, pairsForCandidate);
        if (solution) {
          solvedTransform = solution;
          const primaryPair = pairsForCandidate[0];
          const feas = estimateInsertionFeasibility(sourceObj, targetObj, primaryPair, solution);
          collisionPenalty = feas.collisionPenalty;
          insertionFeasibility = feas.feasibility;
          if (feas.notes.length > 0) {
            diagnostics.push(...feas.notes);
          }
        }
      } catch {
        // feasibility check is best-effort
      }
    }

    const candidate: MatingCandidate = {
      id: crypto.randomUUID(),
      sourcePartId,
      targetPartId,
      featurePairs: pairsForCandidate,
      transform: solvedTransform,
      totalScore: Math.max(0, Math.min(1, totalScore - collisionPenalty * 0.3)),
      scoreBreakdown: {
        featureCompatibility: avgTypeScore,
        dimensionFit: avgDimScore,
        axisAlignment: avgAxisScore,
        faceSupportConsistency: faceSupportScore,
        collisionPenalty,
        insertionFeasibility,
        symmetryAmbiguityPenalty: symmetryPenalty,
        recipePrior: 0, // set by caller if recipe lookup succeeds
      },
      description: buildCandidateDescription(pairsForCandidate, sourcePartId, targetPartId),
      diagnostics,
    };

    candidates.push(candidate);
  }

  // Sort by totalScore descending
  candidates.sort((a, b) => b.totalScore - a.totalScore);

  return candidates;
}
