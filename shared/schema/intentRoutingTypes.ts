/**
 * intentRoutingTypes.ts — Output types for the Feature-First Intent Router.
 *
 * The router maps assembly intent (mount / insert / cover / default) to
 * preferred geometric feature paths, anchor methods, and solver families.
 *
 * Design goals:
 *   - Explicit and debuggable: every routing decision is traceable
 *   - Additive: adds signal on top of existing candidateRows scoring — never replaces it
 *   - Backward-compatible: 'fallback_generic' preserves existing behavior
 */

import type { SolverFamily } from './assemblySemanticTypes.js';

/**
 * Mirror of FeatureType from src/v2/three/mating/featureTypes.ts.
 * Duplicated here so intentRoutingTypes.ts stays in shared/schema (no Three.js deps).
 */
export type AssemblyFeatureKind =
  | 'planar_face'
  | 'cylindrical_hole'
  | 'blind_hole'
  | 'slot'
  | 'peg'
  | 'tab'
  | 'socket'
  | 'rail'
  | 'edge_notch'
  | 'edge_connector'
  | 'support_pad';

// ---------------------------------------------------------------------------
// Feature mode — which geometric feature path to prefer
// ---------------------------------------------------------------------------

export type FeatureMode =
  /** Prefer hole / peg / standoff patterns → pattern_align / peg_hole solver. */
  | 'hole_pattern'
  /** Prefer slot / socket / tab features → slot_insert / peg_hole solver. */
  | 'slot_insert'
  /** Prefer planar face / rim / support-pad alignment → plane_align / rim_align. */
  | 'planar_face'
  /** No strong feature preference — preserve existing candidateRows behavior. */
  | 'fallback_generic';

// ---------------------------------------------------------------------------
// Assembly intent (normalized across languages)
// ---------------------------------------------------------------------------

export type AssemblyIntentKind =
  /**
   * Peer parts grouped into a movable subassembly — NO external target.
   * Trigger: 組起來 / 裝起來 (no 到X上) / group these / assemble together
   */
  | 'assemble_together'
  /**
   * Source entity mounted onto an external structural target.
   * Trigger: 裝到X上 / 固定到 / mount to / attach to
   */
  | 'mount_to_target'
  /** Legacy alias for mount_to_target — kept so existing code compiles unchanged. */
  | 'mount'    // fasten, 固定, 鎖, 裝到, mount, install
  | 'insert'   // 插入, 卡進, 裝進, insert, plug, fit
  | 'cover'    // 蓋上, 覆蓋, cover, place_on, stack
  | 'default'; // no clear intent signal

// ---------------------------------------------------------------------------
// Candidate scoring adjustments (applied in candidateRows block)
// ---------------------------------------------------------------------------

export type IntentCandidateAdjustments = {
  /**
   * Bonus for candidates that use feature-extracting anchor methods
   * (planar_cluster, obb_pca) on BOTH source and target.
   */
  featureMethodBonus: number;

  /**
   * Penalty for candidates that use bbox-only anchor methods
   * (object_aabb, geometry_aabb) on target.
   * Applied when a feature-based alternative exists.
   */
  bboxFallbackPenalty: number;

  /**
   * Additional bonus for vertical face pairs (y-axis alignment)
   * on top of the existing vertical bias.
   */
  verticalPairBonus: number;

  /**
   * Penalty for lateral face pairs (x or z axis).
   */
  lateralPairPenalty: number;
};

// ---------------------------------------------------------------------------
// Full routing decision
// ---------------------------------------------------------------------------

export type IntentRoutingDecision = {
  /** Normalized assembly intent derived from utterance + geometry. */
  assemblyIntent: AssemblyIntentKind;

  /** Which geometric feature path to prefer. */
  usedFeatureMode: FeatureMode;

  /**
   * Feature types to prefer during candidate evaluation.
   * These map to anchor methods likely to detect them (e.g. cylindrical_hole → planar_cluster).
   */
  preferredFeatureTypes: AssemblyFeatureKind[];

  /**
   * Solver families to prefer, in priority order.
   * Feeds into solverScoring.ts planConstraints.preferredSolverFamilies.
   */
  preferredSolverFamilies: SolverFamily[];

  /**
   * Whether to allow plain planar/bbox fallback when no feature candidates win.
   * Always true — we never block the fallback path.
   */
  fallbackAllowed: true;

  /**
   * Whether the fallback was actually used (feature-based routing found no candidates
   * that scored higher than the plain planar baseline).
   * Set to true after scoring when the top candidate is NOT feature-method-based.
   * Populated post-hoc in mcpToolExecutor after candidateRows sort.
   */
  fallbackUsed?: boolean;

  /** Scoring adjustments to apply in the candidateRows block. */
  candidateAdjustments: IntentCandidateAdjustments;

  /** Human-readable trace for debugging. */
  routingDiagnostics: string[];
};
