/**
 * entityResolutionScorer.ts — Server-side entity resolution scoring.
 *
 * Runs in the router (mcp-server) using only RouterContext data.
 * Decides whether to address a source/target as a 'part' or as a 'group'
 * by scoring lightweight text + context signals.
 *
 * Design:
 *   - Stateless: pure function over (utterance, RouterContext)
 *   - No LLM: fast, runs on every mate fast-path invocation
 *   - Deterministic: same inputs → same scores
 *
 * Behavioral contracts:
 *   A. Generic fan command ("幫我裝風扇") with fans in a group → group wins
 *   B. "這組風扇" (explicit group language) → group strongly wins
 *   C. "把 Fan_Left 裝到 THERMAL" (exact child name) → part wins, group penalised
 *   D. Ambiguous (score gap < threshold, no definitive signal) → needsClarification=true
 */

import type { RouterContext } from './types.js';
import {
  type EntityResolutionCandidate,
  type EntityResolutionResult,
  ENTITY_SCORE,
} from '../../../shared/schema/entityResolutionTypes.js';

// ---------------------------------------------------------------------------
// Text signal helpers
// ---------------------------------------------------------------------------

const PLURAL_PATTERNS = [
  /這組|那組|所有|全部|全體|一組/,
  /these|those|all\s+(the\s+)?fans|both\s+fans|fan\s+group/i,
  /兩個(?:風扇|fan)|全部風扇/,
];

const MODULE_KEYWORDS = [
  /組件|模組|群組|子組合|子組件/,
  /module|assembly|group|unit|subassembly/i,
];

function hasPluralLanguage(text: string): boolean {
  return PLURAL_PATTERNS.some((p) => p.test(text));
}

function hasModuleKeyword(text: string): boolean {
  return MODULE_KEYWORDS.some((p) => p.test(text));
}

/** True if the utterance mentions the given name as an exact token (case-insensitive). */
function nameAppearsInText(name: string, text: string): boolean {
  if (!name || !text) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,，.。「」『』（）()|/\\\\])${escaped}(?:$|[\\s,，.。「」『』（）()|/\\\\])`, 'i').test(text)
    || text.toLowerCase().includes(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Candidate builders
// ---------------------------------------------------------------------------

type PartRow = RouterContext['parts'][number];
type GroupRow = NonNullable<RouterContext['groups']>[number];

function buildPartCandidate(
  part: PartRow,
  text: string,
  ctx: RouterContext,
): EntityResolutionCandidate {
  const signals: string[] = [];
  let score = 0;

  // Base: name appears in utterance
  if (nameAppearsInText(part.name, text)) {
    score += ENTITY_SCORE.partNameMatchBonus;
    signals.push(`partNameMatch(+${ENTITY_SCORE.partNameMatchBonus})`);
  }

  // Single-selection bonus: exactly this part selected, not part of a group
  const isSelected =
    ctx.selectionPartId === part.id || ctx.multiSelectIds?.includes(part.id);
  const partGroup = ctx.groups?.find((g) => g.partIds.includes(part.id));
  if (isSelected && !partGroup) {
    score += ENTITY_SCORE.singleSelectionBonus;
    signals.push(`singleSelectionBonus(+${ENTITY_SCORE.singleSelectionBonus})`);
  }

  return {
    entityId: part.id,
    entityType: 'part',
    displayName: part.name,
    memberPartIds: [part.id],
    score,
    signals,
  };
}

function buildGroupCandidate(
  group: GroupRow,
  text: string,
  ctx: RouterContext,
): EntityResolutionCandidate {
  const signals: string[] = [];
  let score = 0;

  // Plural / collective language → group wins
  if (hasPluralLanguage(text)) {
    score += ENTITY_SCORE.pluralLanguageBonus;
    signals.push(`pluralLanguage(+${ENTITY_SCORE.pluralLanguageBonus})`);
  }

  // Explicit module/group keywords → group wins
  if (hasModuleKeyword(text)) {
    score += ENTITY_SCORE.moduleKeywordBonus;
    signals.push(`moduleKeyword(+${ENTITY_SCORE.moduleKeywordBonus})`);
  }

  // Group name itself appears in utterance
  if (nameAppearsInText(group.name, text)) {
    score += ENTITY_SCORE.groupSemanticCoverageBonus;
    signals.push(`groupNameMatch(+${ENTITY_SCORE.groupSemanticCoverageBonus})`);
  }

  // Any member of the group is selected → group should act as rigid body
  const selectedPartInGroup = group.partIds.some(
    (pid) =>
      ctx.selectionPartId === pid || ctx.multiSelectIds?.includes(pid),
  );
  if (selectedPartInGroup) {
    score += ENTITY_SCORE.selectedGroupBonus;
    signals.push(`selectedGroupBonus(+${ENTITY_SCORE.selectedGroupBonus})`);
  }

  // Explicit child name mentioned → penalise group
  const memberParts = group.partIds.map(
    (pid) => ctx.parts.find((p) => p.id === pid),
  ).filter(Boolean) as PartRow[];

  const childNameMentioned = memberParts.some((p) => nameAppearsInText(p.name, text));
  if (childNameMentioned) {
    score += ENTITY_SCORE.explicitChildNamePenaltyToGroup;
    signals.push(`explicitChildNamePenalty(${ENTITY_SCORE.explicitChildNamePenaltyToGroup})`);
  }

  return {
    entityId: group.id,
    entityType: 'group',
    displayName: group.name,
    memberPartIds: [...group.partIds],
    score,
    signals,
  };
}

// Apply explicitChildNameBonus to part candidates whose name appears explicitly
function applyChildNameBonus(
  partCandidate: EntityResolutionCandidate,
  text: string,
): void {
  if (nameAppearsInText(partCandidate.displayName, text)) {
    const partGroup = true; // we only call this when the part IS in a group
    if (partGroup) {
      partCandidate.score += ENTITY_SCORE.explicitChildNameBonus;
      partCandidate.signals.push(`explicitChildNameBonus(+${ENTITY_SCORE.explicitChildNameBonus})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Core scorer
// ---------------------------------------------------------------------------

const CLARIFICATION_GAP_THRESHOLD = 0.15;

/**
 * Score part vs group candidates for a single part reference extracted from text.
 *
 * @param partId  — The matched part ID (from text extraction or selection)
 * @param text    — Full utterance text
 * @param ctx     — Current RouterContext
 * @returns       — Ranked EntityResolutionCandidate array (highest score first)
 */
export function scoreEntityCandidates(
  partId: string,
  text: string,
  ctx: RouterContext,
): EntityResolutionCandidate[] {
  const part = ctx.parts.find((p) => p.id === partId);
  if (!part) return [];

  const candidates: EntityResolutionCandidate[] = [];

  // Always include the part itself
  const partCand = buildPartCandidate(part, text, ctx);
  candidates.push(partCand);

  // Find group(s) that contain this part
  const owningGroups = (ctx.groups ?? []).filter((g) => g.partIds.includes(partId));

  for (const group of owningGroups) {
    const groupCand = buildGroupCandidate(group, text, ctx);
    candidates.push(groupCand);

    // Boost part if its name is explicitly mentioned (when it's inside a group)
    if (owningGroups.length > 0) {
      applyChildNameBonus(partCand, text);
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ---------------------------------------------------------------------------
// Full resolution: source + target
// ---------------------------------------------------------------------------

/**
 * Resolve both source and target entity for a mate command.
 *
 * @param sourcePartId — Part ID matched from utterance / selection for source
 * @param targetPartId — Part ID matched for target
 * @param text         — Full utterance
 * @param ctx          — RouterContext
 */
export function resolveEntityPair(
  sourcePartId: string,
  targetPartId: string,
  text: string,
  ctx: RouterContext,
): EntityResolutionResult {
  const diagnostics: string[] = [];

  const sourceCandidates = scoreEntityCandidates(sourcePartId, text, ctx);
  const targetCandidates = scoreEntityCandidates(targetPartId, text, ctx);

  const topSource = sourceCandidates[0] ?? null;
  const runnerSource = sourceCandidates[1] ?? null;
  const topTarget = targetCandidates[0] ?? null;

  // Detect ambiguity: top two source candidates within gap threshold
  const sourceScoreGap = topSource && runnerSource
    ? Math.abs(topSource.score - runnerSource.score)
    : Infinity;

  const isAmbiguous =
    topSource &&
    runnerSource &&
    sourceScoreGap < CLARIFICATION_GAP_THRESHOLD &&
    // Only flag as ambiguous when there are competing part/group types
    topSource.entityType !== runnerSource.entityType;

  if (topSource) diagnostics.push(`source top: ${topSource.entityType}(${topSource.displayName}) score=${topSource.score.toFixed(2)} signals=[${topSource.signals.join(', ')}]`);
  if (topTarget) diagnostics.push(`target top: ${topTarget.entityType}(${topTarget.displayName}) score=${topTarget.score.toFixed(2)} signals=[${topTarget.signals.join(', ')}]`);
  if (isAmbiguous) diagnostics.push(`ambiguous: gap=${sourceScoreGap.toFixed(2)}`);

  let clarificationQuestion: string | undefined;
  if (isAmbiguous && topSource && runnerSource) {
    const groupCand = [topSource, runnerSource].find(c => c.entityType === 'group');
    const partCand  = [topSource, runnerSource].find(c => c.entityType === 'part');
    if (groupCand && partCand) {
      clarificationQuestion = `你要移動整個「${groupCand.displayName}」群組，還是只移動「${partCand.displayName}」？`;
    }
  }

  return {
    sourceEntityCandidates: sourceCandidates,
    targetEntityCandidates: targetCandidates,
    sourceResolvedAs: topSource?.entityType ?? null,
    targetResolvedAs: topTarget?.entityType ?? null,
    needsClarification: !!isAmbiguous,
    clarificationQuestion,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Convenience: extract mate args from resolution result
// ---------------------------------------------------------------------------

/**
 * Build mate tool args from a resolved entity pair.
 * Mirrors the existing `buildMateArgs` pattern in smartProvider but uses scored resolution.
 */
export function buildMateArgsFromResolution(
  sourcePartId: string,
  targetPartId: string,
  resolution: EntityResolutionResult,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const topSource = resolution.sourceEntityCandidates[0];

  const sourceGroupId =
    topSource?.entityType === 'group' ? topSource.entityId : undefined;

  return {
    sourcePart: { partId: sourcePartId },
    targetPart: { partId: targetPartId },
    ...(sourceGroupId ? { sourceGroupId } : {}),
    ...extra,
  };
}
