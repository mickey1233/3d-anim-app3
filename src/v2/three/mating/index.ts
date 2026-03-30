/**
 * mating/index.ts — Public API for the mating module.
 *
 * Exports both the legacy v2 face-based API (unchanged) and the new v3 feature-based API.
 * All v2 callers can keep using the existing imports and will not be affected.
 */

// --- New v3 feature-based API ---
export * from './featureTypes';
export * from './featureExtractor';
export * from './featureMatcher';
export * from './featureSolver';
export { scoreSolvers, deriveSolverPriorsFromDemonstrations } from './solverScoring';
export type { SolverScoringInput } from './solverScoring';
export type { AssemblySemanticDescription, DemonstrationPriorScore, SolverFamily, SolverScore, SolverScoringResult } from './featureTypes';

// --- Legacy v2 face-based API (unchanged) ---
export { clusterPlanarFaces } from './faceClustering';
export type { FaceCluster } from './faceClustering';
export { resolveAnchor } from './anchorMethods';
export type { AnchorResult } from './anchorMethods';
export { solveMateTopBottom, applyMateTransform, solveMateFromAnchors, getFaceByDirection } from './solver';
export type { MateTransform } from './solver';
