/**
 * assemblyPlanner.ts — Thin planning layer between grounding and solver scoring.
 *
 * Takes resolved source/target + utterance context and produces constraints that
 * guide candidate generation and solver selection.  No new solvers, no VLM calls.
 *
 * Fixes:
 *  A. Planning constraints between grounding and solver
 *  C. Anti-self-stack for fan-like parts
 *  D. Group-aware source entity type
 *  E. Mount intent target-face preference
 */
import type { SolverFamily } from '../../../../shared/schema/assemblySemanticTypes';
import type { PartGroundingCandidate } from './partSemanticTypes';
import { getCard } from './partSemanticRegistry';

export type AssemblyPlanConstraints = {
  /** Explicit target must NOT be overridden by selection context */
  mustUseResolvedTarget: boolean;
  /** Whether source is a single part or an assembly group */
  sourceEntityType: 'part' | 'group';
  /** Set when sourceEntityType === 'group' */
  sourceGroupId?: string;
  /** Preferred solver families in priority order */
  preferredSolverFamilies: SolverFamily[];
  /** Penalise top/bottom plane-stack when true (e.g., fan-to-fan) */
  disallowSameCategorySelfStack: boolean;
  /** Feature types that should score higher on the TARGET part */
  preferredTargetFeatureTypes: string[];
  /** Face role to prefer on the target (relevant for mount intent) */
  preferredTargetFaceRole: 'top' | 'front' | 'lateral' | 'any';
  /** Human-readable notes for debugging */
  planningNotes: string[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isFanLike(partName: string, category?: string): boolean {
  return /fan|FAN|風扇|blower|cooling/i.test(partName) ||
    /fan|cooling|blower/i.test(category ?? '');
}

function isStructuralTarget(partName: string): boolean {
  return /thermal|chassis|cover|board|base|frame|housing|motherboard/i.test(partName);
}

// ── Main planner ──────────────────────────────────────────────────────────────

export function planAssemblyConstraints(
  utterance: string,
  source: PartGroundingCandidate | null,
  target: PartGroundingCandidate | null,
  options: {
    targetExplicitlyMentioned: boolean;
    sourceGroupId?: string;
  },
): AssemblyPlanConstraints {
  const notes: string[] = [];

  const srcName = source?.partName ?? '';
  const tgtName = target?.partName ?? '';
  const srcCategory = source ? (getCard(source.partId)?.vlmCategory ?? '') : '';
  const tgtCategory = target ? (getCard(target.partId)?.vlmCategory ?? '') : '';

  const srcFan = isFanLike(srcName, srcCategory);
  const tgtFan = isFanLike(tgtName, tgtCategory);
  const bothFan = srcFan && tgtFan;

  const mountToStructure = isStructuralTarget(tgtName) &&
    /mount|attach|install|裝到|安裝|固定/i.test(utterance);

  // Preferred solver families
  const preferredSolvers: SolverFamily[] = [];
  if (bothFan) {
    preferredSolvers.push('pattern_align');
    notes.push('fan-to-fan: prefer pattern_align; penalise vertical stack');
  }
  if (mountToStructure) {
    preferredSolvers.push('pattern_align', 'plane_align');
    notes.push(`mount-to-structure(${tgtName}): prefer top/front mounting face`);
  }

  // Preferred target feature types
  const preferredTargetFeatureTypes: string[] = [];
  if (bothFan || mountToStructure) {
    preferredTargetFeatureTypes.push('cylindrical_hole', 'blind_hole');
  }

  // Target face role
  let preferredTargetFaceRole: AssemblyPlanConstraints['preferredTargetFaceRole'] = 'any';
  if (mountToStructure) preferredTargetFaceRole = 'top';
  else if (bothFan) preferredTargetFaceRole = 'lateral';

  return {
    mustUseResolvedTarget: options.targetExplicitlyMentioned,
    sourceEntityType: options.sourceGroupId ? 'group' : 'part',
    sourceGroupId: options.sourceGroupId,
    preferredSolverFamilies: preferredSolvers,
    disallowSameCategorySelfStack: bothFan,
    preferredTargetFeatureTypes,
    preferredTargetFaceRole,
    planningNotes: notes,
  };
}

/**
 * Detect whether the utterance contains an explicit target concept (not deictic).
 * Used to set mustUseResolvedTarget.
 */
export function hasExplicitTargetInUtterance(
  utterance: string,
  targetConcept: string | undefined,
): boolean {
  if (!targetConcept) return false;
  // targetConcept was extracted from the utterance text — its presence means explicit
  return utterance.toLowerCase().includes(targetConcept.toLowerCase());
}
