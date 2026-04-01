/**
 * intentRouter.ts — Feature-First Intent Router for assembly planning.
 *
 * Maps assembly utterance + geometry intent → preferred feature paths.
 *
 * Design:
 *   - Pure function: no Three.js, no store access
 *   - Additive: output is used to BIAS candidateRows scoring, not replace it
 *   - Explicit: every decision is traceable via routingDiagnostics
 *   - Fallback-safe: always allows planar fallback when feature-based path fails
 *
 * Three routing paths:
 *   mount  → hole_pattern  (cylindrical_hole / blind_hole / peg / standoff patterns)
 *   insert → slot_insert   (slot / socket / tab / opening)
 *   cover  → planar_face   (planar face / rim / support_pad)
 *   other  → fallback_generic (no override, preserve existing behavior)
 *
 * Candidate scoring adjustments (applied in mcpToolExecutor candidateRows block):
 *   - featureMethodBonus: reward planar_cluster / obb_pca pairs (they detect features)
 *   - bboxFallbackPenalty: penalize object_aabb / geometry_aabb on target
 *   - verticalPairBonus: extra Y-axis preference per intent
 *   - lateralPairPenalty: reduce lateral pair score per intent
 */

import type {
  IntentRoutingDecision,
  AssemblyIntentKind,
  FeatureMode,
  AssemblyFeatureKind,
  IntentCandidateAdjustments,
} from '../../../../shared/schema/intentRoutingTypes.js';
import type { SolverFamily } from '../../../../shared/schema/assemblySemanticTypes.js';

// ---------------------------------------------------------------------------
// Text-based intent detection
// ---------------------------------------------------------------------------

const MOUNT_PATTERNS = [
  /mount|fasten|fix|attach|install|bolt|screw|lock/i,
  /固定|鎖(?:到|上|緊)|裝(?:到|上)|安裝|鎖螺絲|螺絲|鎖付|鎖合/,
  /掛(?:到|上)|挂|固/,
];

const INSERT_PATTERNS = [
  /insert|plug|fit into|slot in|snap in|push in/i,
  /插(?:入|到|進)|卡(?:進|入)|裝(?:進|入)|嵌(?:入|進)|套(?:入|進)/,
  /扣(?:入|進)|嵌合|插槽/,
];

const COVER_PATTERNS = [
  /cover|cap|lid|close|stack|place on|put on|lay on/i,
  /蓋(?:上|住)|覆蓋|罩上|疊(?:上|放)|放(?:上|到)|置(?:上|於)/,
  /合上|封上|壓(?:上|到)/,
];

function detectTextIntent(text: string): AssemblyIntentKind | null {
  if (!text) return null;
  if (MOUNT_PATTERNS.some(p => p.test(text))) return 'mount';
  if (INSERT_PATTERNS.some(p => p.test(text))) return 'insert';
  if (COVER_PATTERNS.some(p => p.test(text))) return 'cover';
  return null;
}

// ---------------------------------------------------------------------------
// Geometry intent → assembly intent mapping
// ---------------------------------------------------------------------------

/** Map from mcpToolExecutor `geometryIntent` to assembly intent. */
function mapGeometryIntent(geometryIntent: string): AssemblyIntentKind | null {
  if (geometryIntent === 'insert') return 'insert';
  if (geometryIntent === 'cover') return 'cover';
  return null;
}

// ---------------------------------------------------------------------------
// Per-intent routing tables
// ---------------------------------------------------------------------------

type IntentConfig = {
  featureMode: FeatureMode;
  preferredFeatureTypes: AssemblyFeatureKind[];
  preferredSolverFamilies: SolverFamily[];
  adjustments: IntentCandidateAdjustments;
};

const INTENT_CONFIG: Record<AssemblyIntentKind, IntentConfig> = {
  mount: {
    featureMode: 'hole_pattern',
    // Holes, pegs, standoffs — physical fastening features
    preferredFeatureTypes: ['cylindrical_hole', 'blind_hole', 'peg', 'support_pad'],
    // pattern_align first (multi-hole kabsch), peg_hole second (single peg/pin)
    preferredSolverFamilies: ['pattern_align', 'peg_hole', 'plane_align'],
    adjustments: {
      // Strongly reward feature-extracting methods (planar_cluster finds holes)
      featureMethodBonus:    0.28,
      // Heavily penalize bbox-only anchor — it aligns to flat face centroid, not fastening features
      bboxFallbackPenalty:  -0.22,
      // Moderate vertical preference (fastening is often top→bottom or bottom→top)
      verticalPairBonus:     0.08,
      // Lateral face pairs unlikely for mount ops
      lateralPairPenalty:   -0.08,
    },
  },

  insert: {
    featureMode: 'slot_insert',
    // Slot, socket, tab features — snap/plug geometry
    preferredFeatureTypes: ['slot', 'socket', 'tab', 'edge_notch', 'peg'],
    // slot_insert first, peg_hole for snap-pin style
    preferredSolverFamilies: ['slot_insert', 'peg_hole', 'plane_align'],
    adjustments: {
      // Feature-extracting methods can find slots/sockets
      featureMethodBonus:    0.18,
      // Bbox-only won't find slot opening
      bboxFallbackPenalty:  -0.14,
      // Insert is typically axial — vertical or depth-axis pairs preferred
      verticalPairBonus:     0.12,
      lateralPairPenalty:   -0.06,
    },
  },

  cover: {
    featureMode: 'planar_face',
    // Large flat faces, rim, support surfaces
    preferredFeatureTypes: ['planar_face', 'support_pad'],
    // plane_align is the natural solver; rim_align as second
    preferredSolverFamilies: ['plane_align', 'rim_align', 'pattern_align'],
    adjustments: {
      // Planar methods already preferred by existing cover logic; add modest extra
      featureMethodBonus:    0.08,
      // Bbox face centroid is acceptable for cover ops — smaller penalty
      bboxFallbackPenalty:  -0.06,
      // Cover almost always vertical (top→bottom)
      verticalPairBonus:     0.14,
      lateralPairPenalty:   -0.10,
    },
  },

  default: {
    featureMode: 'fallback_generic',
    preferredFeatureTypes: [],
    preferredSolverFamilies: [],
    adjustments: {
      featureMethodBonus:    0,
      bboxFallbackPenalty:   0,
      verticalPairBonus:     0,
      lateralPairPenalty:    0,
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type IntentRouterInput = {
  /** Raw user instruction text. */
  instruction: string;

  /** Source part name (for semantic hints). */
  sourceName: string;

  /** Target part name (for semantic hints). */
  targetName: string;

  /**
   * Geometry-derived intent from mcpToolExecutor ('default' | 'cover' | 'insert').
   * Used as fallback when text detection finds no signal.
   */
  geometryIntent: string;
};

/**
 * Route assembly intent to preferred feature paths.
 *
 * Priority:
 *   1. Text-detected intent (most explicit signal)
 *   2. Geometry-derived intent (position/size heuristic)
 *   3. default (no override)
 */
export function routeAssemblyIntent(input: IntentRouterInput): IntentRoutingDecision {
  const diagnostics: string[] = [];

  // Step 1: text-based detection
  const textIntent = detectTextIntent(input.instruction);
  if (textIntent) {
    diagnostics.push(`text_intent=${textIntent} (matched text pattern)`);
  }

  // Step 2: geometry-based fallback
  const geoIntent = mapGeometryIntent(input.geometryIntent);
  if (!textIntent && geoIntent) {
    diagnostics.push(`geo_intent=${geoIntent} (from geometry heuristic)`);
  }

  const resolvedIntent: AssemblyIntentKind = textIntent ?? geoIntent ?? 'default';
  if (resolvedIntent === 'default') {
    diagnostics.push('no intent signal found → fallback_generic');
  }

  const config = INTENT_CONFIG[resolvedIntent];

  diagnostics.push(
    `featureMode=${config.featureMode}`,
    `preferredSolvers=[${config.preferredSolverFamilies.join(', ')}]`,
    `preferredFeatures=[${config.preferredFeatureTypes.join(', ')}]`,
    `featureMethodBonus=${config.adjustments.featureMethodBonus}`,
    `bboxFallbackPenalty=${config.adjustments.bboxFallbackPenalty}`,
  );

  return {
    assemblyIntent: resolvedIntent,
    usedFeatureMode: config.featureMode,
    preferredFeatureTypes: config.preferredFeatureTypes,
    preferredSolverFamilies: config.preferredSolverFamilies,
    fallbackAllowed: true,
    candidateAdjustments: config.adjustments,
    routingDiagnostics: diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Candidate scoring helper (used inside candidateRows flatMap)
// ---------------------------------------------------------------------------

export type AnchorMethodId = string; // avoids importing the full executor enum

/** Feature-extracting anchor methods (detect holes, slots, pegs from mesh). */
const FEATURE_EXTRACTING_METHODS = new Set(['planar_cluster', 'obb_pca']);

/** Bbox-only anchor methods (no feature detection, just bounding box). */
const BBOX_METHODS = new Set(['object_aabb', 'geometry_aabb']);

/**
 * Apply intent-routing score adjustments to a single candidate row.
 *
 * @param routing   — Result of routeAssemblyIntent()
 * @param row       — One candidateRows entry (sourceMethod, targetMethod, axis)
 * @param isVertical — Whether this candidate is a vertical (Y-axis) face pair
 * @param isLateral  — Whether this candidate is a lateral (X/Z-axis) face pair
 * @returns { delta, tags } — Score delta and diagnostic tags to push
 */
export function applyRoutingAdjustments(
  routing: IntentRoutingDecision,
  row: { sourceMethod: string; targetMethod: string },
  isVertical: boolean,
  isLateral: boolean,
): { delta: number; tags: string[] } {
  if (routing.usedFeatureMode === 'fallback_generic') {
    return { delta: 0, tags: [] };
  }

  const adj = routing.candidateAdjustments;
  let delta = 0;
  const tags: string[] = [];

  // Feature-extracting methods bonus
  const srcIsFeature = FEATURE_EXTRACTING_METHODS.has(row.sourceMethod);
  const tgtIsFeature = FEATURE_EXTRACTING_METHODS.has(row.targetMethod);
  if (srcIsFeature && tgtIsFeature) {
    delta += adj.featureMethodBonus;
    tags.push(`route_feature_method_bonus(+${adj.featureMethodBonus.toFixed(2)})`);
  }

  // Bbox fallback penalty — only penalize target bbox; source bbox is less critical
  if (BBOX_METHODS.has(row.targetMethod) && adj.bboxFallbackPenalty < 0) {
    delta += adj.bboxFallbackPenalty;
    tags.push(`route_bbox_fallback_penalty(${adj.bboxFallbackPenalty.toFixed(2)})`);
  }

  // Vertical pair adjustments
  if (isVertical && adj.verticalPairBonus !== 0) {
    delta += adj.verticalPairBonus;
    tags.push(`route_vertical_pair_bonus(+${adj.verticalPairBonus.toFixed(2)})`);
  }

  // Lateral pair adjustments
  if (isLateral && adj.lateralPairPenalty !== 0) {
    delta += adj.lateralPairPenalty;
    tags.push(`route_lateral_penalty(${adj.lateralPairPenalty.toFixed(2)})`);
  }

  // Tag the routing mode for diagnostics
  tags.push(`intent_route:${routing.usedFeatureMode}`);

  return { delta, tags };
}

// ---------------------------------------------------------------------------
// Post-sort: detect whether fallback was used
// ---------------------------------------------------------------------------

/**
 * After candidateRows are sorted by semanticScore, check whether the winning
 * candidate is feature-method-based or fell back to bbox/generic.
 */
export function detectFallbackUsed(
  topCandidate: { sourceMethod: string; targetMethod: string } | null | undefined,
): boolean {
  if (!topCandidate) return true;
  const srcIsFeature = FEATURE_EXTRACTING_METHODS.has(topCandidate.sourceMethod);
  const tgtIsFeature = FEATURE_EXTRACTING_METHODS.has(topCandidate.targetMethod);
  return !(srcIsFeature && tgtIsFeature);
}
