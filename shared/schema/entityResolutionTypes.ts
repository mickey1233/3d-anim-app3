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
} as const;

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
