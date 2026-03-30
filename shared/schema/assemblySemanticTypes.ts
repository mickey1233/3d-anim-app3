/**
 * assemblySemanticTypes.ts — Shared canonical types for the 3-layer assembly architecture.
 *
 * These types are used by both frontend (src/v2/) and backend (mcp-server/v2/).
 * Frontend imports: from '../../../../shared/schema/assemblySemanticTypes'
 * Backend imports:  from '../../../shared/schema/assemblySemanticTypes.js'
 */

// ─── Layer 1: VLM Semantic Description ───────────────────────────────────────

export type PartRole =
  | 'cap' | 'lid' | 'cover' | 'plug' | 'connector'
  | 'body' | 'housing' | 'base' | 'chassis' | 'frame' | 'rack' | 'socket'
  | 'bracket' | 'panel' | 'tray' | 'mount'
  | 'unknown';

export type AssemblyIntent =
  | 'insert' | 'cover' | 'mount' | 'slide' | 'screw' | 'snap' | 'default';

export type SolverFamily =
  | 'plane_align'    // flat face to flat face (implemented)
  | 'peg_hole'       // single peg into hole (implemented)
  | 'pattern_align'  // multi-point Kabsch SVD (implemented)
  | 'slot_insert'    // slot/pocket mating (planned)
  | 'rim_align'      // circular rim to opening (planned)
  | 'rail_slide';    // rail/groove sliding (planned)

export type AssemblySemanticDescription = {
  sourceRole: PartRole;
  targetRole: PartRole;
  assemblyIntent: AssemblyIntent;
  /** e.g. "fan mounts onto side panel" */
  relationship: string;
  /** face names most likely to be contact regions, e.g. ["bottom", "top"] */
  likelyContactRegions: string[];
  /** e.g. "top" or "y_axis" */
  likelyApproachDirection: string;
  /** solver families VLM believes are applicable */
  preferredSolverHints: SolverFamily[];
  /** VLM reasoning text */
  reasoning: string;
  confidence: number;
};

// ─── Shared: Demonstration Prior Score ───────────────────────────────────────

/**
 * DemonstrationPriorScore — canonical type for demonstration relevance scores.
 * Used by server (mateRecipes.ts), WS gateway, and frontend (mcpToolExecutor.ts, featureMatcher.ts).
 */
export type DemonstrationPriorScore = {
  demonstrationId: string;
  sourcePartName: string;
  targetPartName: string;
  totalScore: number;
  nameMatchScore: number;
  featureTypeScore: number;
  textScore: number;
  matchedFeatureTypes: string[];
  generalizedRuleSummary?: string;
};

// ─── Layer 2: Solver Scoring ──────────────────────────────────────────────────

export type SolverScoreComponent = {
  geometryCompatibility: number;
  featureCompatibility: number;
  semanticIntentMatch: number;
  demonstrationPrior: number;
  recipePrior: number;
  symmetryResolutionGain: number;
  insertionAxisConfidence: number;
};

export type SolverScore = {
  solver: SolverFamily;
  totalScore: number;
  components: SolverScoreComponent;
  reasons: string[];
  /** true if this solver has a complete implementation */
  implemented: boolean;
};

export type SolverScoringResult = {
  rankedSolvers: SolverScore[];
  recommendedSolver: SolverFamily;
  confidence: number;
  diagnostics: string[];
};
