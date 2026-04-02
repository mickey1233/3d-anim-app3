/**
 * entityResolutionTypes.ts — Output types for the entity-resolution scoring layer.
 *
 * The scorer ranks part vs group vs subassembly candidates for a given utterance
 * using lightweight text/context signals.  It runs server-side (no Three.js) and
 * is the bridge between raw `RouterContext` parts/groups and the `AssemblyEntity`
 * abstraction.
 */

import type { AssemblyEntityType } from './assemblyEntity.js';

// ---------------------------------------------------------------------------
// Per-candidate result
// ---------------------------------------------------------------------------

export type EntityResolutionCandidate = {
  /** Stable ID: partId for 'part', groupId for 'group'. */
  entityId: string;

  entityType: AssemblyEntityType;

  /** Human-readable label. */
  displayName: string;

  /** All part IDs under this entity. */
  memberPartIds: string[];

  /** Aggregate signal score (higher = more likely to be the correct entity). */
  score: number;

  /** Which signals fired and their contribution (for diagnostics). */
  signals: string[];
};

// ---------------------------------------------------------------------------
// Per-signal score constants (exported so callers can tune)
// ---------------------------------------------------------------------------

export const ENTITY_SCORE = {
  /** Source part is selected AND belongs to a group → group candidate gets bonus. */
  selectedGroupBonus: 0.35,

  /** Utterance has explicit plural or collective language ("這組", "all fans") → group. */
  pluralLanguageBonus: 0.25,

  /** Utterance uses group/module/assembly keywords ("組件", "模組", "module") → group. */
  moduleKeywordBonus: 0.30,

  /**
   * Utterance mentions an exact child part name (member of a group) → part wins.
   * Applied to the part candidate.
   */
  explicitChildNameBonus: 0.40,

  /**
   * Same condition as above but penalises the parent group candidate.
   */
  explicitChildNamePenaltyToGroup: -0.30,

  /** Group display name appears in the utterance → group gets a coverage bonus. */
  groupSemanticCoverageBonus: 0.20,

  /**
   * Exactly one part selected, no group in context for that selection → part wins.
   */
  singleSelectionBonus: 0.25,

  /**
   * Part name exactly matches a token in the utterance (base score for part candidates).
   */
  partNameMatchBonus: 0.15,

  /**
   * Entity matches a stored recent referent AND utterance has a deictic pronoun
   * ("它", "this", "them", "那個" etc.) → boost the referent entity.
   */
  recentReferentBonus: 0.30,

  /**
   * Only one valid target remains after excluding source members — the sole
   * remaining candidate is almost certainly the target.
   */
  soleRemainingTargetBonus: 0.20,
} as const;

// ---------------------------------------------------------------------------
// Confidence types
// ---------------------------------------------------------------------------

/** Three-state confidence result for an assembly command. */
export type ConfidenceState = 'high' | 'medium' | 'low';

/**
 * What kind of ambiguity caused a non-high confidence state.
 * Drives targeted clarification question generation.
 */
export type AmbiguityType =
  | 'part_vs_group'           // top-2 source candidates are competing part vs group
  | 'multiple_source_peers'   // top-2 source candidates are same type
  | 'multiple_target_peers'   // top-2 target candidates both have positive signal
  | 'target_unclear'          // source resolved but target has no signal
  | 'source_unclear'          // source cannot be resolved
  | 'both_unclear';           // neither source nor target has any signal

/** Full confidence assessment for an assembly utterance. */
export type ConfidenceAssessment = {
  state: ConfidenceState;
  sourceCandidates: EntityResolutionCandidate[];
  targetCandidates: EntityResolutionCandidate[];
  /** Normalized assembly intent (mount / insert / cover / default). */
  normalizedIntent: string;
  ambiguityType: AmbiguityType | null;
  clarificationQuestion: string | null;
  /** One-line summary for diagnostics / response metadata. */
  confidenceSummary: string;
  usedSelectionSignal: boolean;
  usedRecentReferent: boolean;
  diagnostics: string[];
};

// ---------------------------------------------------------------------------
// Recent referents (stored per session, used for pronoun resolution)
// ---------------------------------------------------------------------------

/**
 * A recently-used entity in an assembly command.
 * Stored on the frontend store and sent in RouterContext so the server
 * can resolve deictic pronouns like "它", "this", "them".
 */
export type RecentReferent = {
  entityId: string;
  entityType: 'part' | 'group';
  displayName: string;
  memberPartIds: string[];
  role: 'source' | 'target';
  timestamp: number;
};

// ---------------------------------------------------------------------------
// Full resolution result
// ---------------------------------------------------------------------------

export type EntityResolutionResult = {
  /** Ranked candidates for the source entity (highest score first). */
  sourceEntityCandidates: EntityResolutionCandidate[];

  /** Ranked candidates for the target entity (highest score first). */
  targetEntityCandidates: EntityResolutionCandidate[];

  /** Entity type of the top-scoring source candidate. */
  sourceResolvedAs: AssemblyEntityType | null;

  /** Entity type of the top-scoring target candidate. */
  targetResolvedAs: AssemblyEntityType | null;

  /**
   * True when the top two source candidates are within 0.15 of each other
   * AND neither has a definitive signal — the UI should ask for clarification.
   */
  needsClarification: boolean;

  /** Present when needsClarification is true. */
  clarificationQuestion?: string;

  /** Human-readable signal trace for debugging. */
  diagnostics: string[];
};
