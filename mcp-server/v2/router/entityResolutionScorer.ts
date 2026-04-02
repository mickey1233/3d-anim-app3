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
  type ConfidenceState,
  type AmbiguityType,
  type ConfidenceAssessment,
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

// ---------------------------------------------------------------------------
// Fuzzy name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a name for fuzzy comparison.
 * Strips spaces, underscores, hyphens; lowercases.
 * Allows group1 == group_1 == group-1 == group 1 == Group 1
 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]/g, '');
}

/** True if the utterance contains `name` either as an exact or fuzzy match. */
function nameAppearsInText(name: string, text: string): boolean {
  if (!name || !text) return false;
  // Exact (case-insensitive, token-boundary)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    new RegExp(`(?:^|[\\s,，.。「」『』（）()|/\\\\])${escaped}(?:$|[\\s,，.。「」『』（）()|/\\\\])`, 'i').test(text) ||
    text.toLowerCase().includes(name.toLowerCase())
  ) return true;
  // Fuzzy: normalized name appears in normalized text
  const normN = normalizeName(name);
  const normT = normalizeName(text);
  return normN.length >= 3 && normT.includes(normN);
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

// ---------------------------------------------------------------------------
// Context-aware resolution: source from selection/group, target from text
// ---------------------------------------------------------------------------

export type ContextResolutionSource =
  | { kind: 'group'; groupId: string; representativePartId: string; displayName: string }
  | { kind: 'part';  partId: string; displayName: string };

export type ContextResolutionResult = {
  source: ContextResolutionSource;
  targetPartId: string;
  targetName: string;
  sourceGroupId: string | null;
  /** How source was resolved. */
  sourceResolvedBy: 'group_name_in_text' | 'selected_group' | 'selected_part' | 'first_part_in_text';
  /** How target was resolved. */
  targetResolvedBy: 'part_name_in_text';
  diagnostics: string[];
};

/**
 * Context-aware resolution for mate commands.
 *
 * Source resolution priority (highest → lowest):
 *   1. Group name explicitly appears in text → use that group
 *   2. Selected part is in a group + utterance has group/module/collective signal → use group
 *   3. Selected part is in a group (no special signal) → use group (group wins by default when selected)
 *   4. Selected part has no group → use selected part
 *   5. First part name found in text that is NOT the target → use that part
 *
 * Target resolution:
 *   - First part name in text that is NOT a member of the resolved source group
 *
 * Returns null when no target can be identified.
 */
export function resolveEntityPairFromContext(
  text: string,
  ctx: RouterContext,
): ContextResolutionResult | null {
  const diagnostics: string[] = [];
  const groups = ctx.groups ?? [];

  // ── Step 1: Resolve source ──────────────────────────────────────────────

  let source: ContextResolutionSource | null = null;
  let sourceResolvedBy: ContextResolutionResult['sourceResolvedBy'] | null = null;
  let sourceMemberIds = new Set<string>();

  // 1a. Group name appears explicitly in text
  for (const group of groups) {
    if (nameAppearsInText(group.name, text)) {
      source = {
        kind: 'group',
        groupId: group.id,
        representativePartId: group.partIds[0] ?? '',
        displayName: group.name,
      };
      sourceResolvedBy = 'group_name_in_text';
      sourceMemberIds = new Set(group.partIds);
      diagnostics.push(`source: group_name_in_text group=${group.name}(${group.id})`);
      break;
    }
  }

  // 1b. Selected part drives group resolution
  if (!source && ctx.selectionPartId) {
    const selectedGroup = groups.find((g) => g.partIds.includes(ctx.selectionPartId!));
    if (selectedGroup) {
      // When selection is in a group, always use the group as source (group-first policy).
      // The group is what the user intends to move.
      source = {
        kind: 'group',
        groupId: selectedGroup.id,
        representativePartId: ctx.selectionPartId,
        displayName: selectedGroup.name,
      };
      sourceResolvedBy = hasPluralLanguage(text) || hasModuleKeyword(text)
        ? 'selected_group'
        : 'selected_group';
      sourceMemberIds = new Set(selectedGroup.partIds);
      diagnostics.push(`source: selected_group group=${selectedGroup.name}(${selectedGroup.id}) signal=${hasPluralLanguage(text) ? 'plural' : hasModuleKeyword(text) ? 'module' : 'default'}`);
    } else {
      // Selected part, no group
      const part = ctx.parts.find((p) => p.id === ctx.selectionPartId);
      if (part) {
        source = { kind: 'part', partId: part.id, displayName: part.name };
        sourceResolvedBy = 'selected_part';
        sourceMemberIds = new Set([part.id]);
        diagnostics.push(`source: selected_part part=${part.name}(${part.id})`);
      }
    }
  }

  // ── Step 2: Find target — first part name in text NOT in source members ──
  // Uses nameAppearsInText (which includes fuzzy normalization) for matching.

  const lowerText = text.toLowerCase();
  const normText = normalizeName(text);
  let targetPart: { id: string; name: string } | null = null;

  // Sort parts by where their name (or normalized name) appears in text
  const textMatches = ctx.parts
    .filter((p) => !sourceMemberIds.has(p.id))
    .map((p) => {
      const exactIdx = lowerText.indexOf(p.name.toLowerCase());
      const fuzzyIdx = exactIdx >= 0 ? exactIdx : normText.indexOf(normalizeName(p.name));
      return { p, idx: Math.max(exactIdx, fuzzyIdx) };
    })
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  if (textMatches.length > 0 && textMatches[0]) {
    targetPart = { id: textMatches[0].p.id, name: textMatches[0].p.name };
    diagnostics.push(`target: part_name_in_text part=${targetPart.name}(${targetPart.id})`);
  }

  if (!targetPart) {
    diagnostics.push('target: not found in text');
    return null;
  }

  // ── Step 3: Fallback source — first part name in text not equal to target ──

  if (!source) {
    const srcMatch = ctx.parts
      .filter((p) => p.id !== targetPart!.id)
      .map((p) => ({ p, idx: lowerText.indexOf(p.name.toLowerCase()) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx)[0];

    if (srcMatch) {
      const owningGroup = groups.find((g) => g.partIds.includes(srcMatch.p.id));
      if (owningGroup) {
        source = {
          kind: 'group',
          groupId: owningGroup.id,
          representativePartId: srcMatch.p.id,
          displayName: owningGroup.name,
        };
        sourceResolvedBy = 'first_part_in_text';
        diagnostics.push(`source: first_part_in_text→group group=${owningGroup.name}`);
      } else {
        source = { kind: 'part', partId: srcMatch.p.id, displayName: srcMatch.p.name };
        sourceResolvedBy = 'first_part_in_text';
        diagnostics.push(`source: first_part_in_text→part part=${srcMatch.p.name}`);
      }
    }
  }

  if (!source) {
    diagnostics.push('source: not found');
    return null;
  }

  return {
    source,
    targetPartId: targetPart.id,
    targetName: targetPart.name,
    sourceGroupId: source.kind === 'group' ? source.groupId : null,
    sourceResolvedBy: sourceResolvedBy!,
    targetResolvedBy: 'part_name_in_text',
    diagnostics,
  };
}

/**
 * Build mate tool args directly from a ContextResolutionResult.
 */
export function buildMateArgsFromContext(
  ctx: ContextResolutionResult,
): Record<string, unknown> {
  const repPartId = ctx.source.kind === 'group'
    ? ctx.source.representativePartId
    : ctx.source.partId;

  return {
    sourcePart: { partId: repPartId },
    targetPart: { partId: ctx.targetPartId },
    ...(ctx.sourceGroupId ? { sourceGroupId: ctx.sourceGroupId } : {}),
  };
}

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

// ---------------------------------------------------------------------------
// Deictic pronoun detection (for recent-referent signal)
// ---------------------------------------------------------------------------

const DEICTIC_PATTERNS = [
  /它|他|那個|這個|這件|那件|這塊|那塊|這零件|那零件/,
  /\b(?:it|this|that|them|those|these|the\s+part|the\s+one)\b/i,
];

export function hasDicticLanguage(text: string): boolean {
  return DEICTIC_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Full-scene candidate ranking (works without pre-selected partId)
// ---------------------------------------------------------------------------

const HIGH_CONFIDENCE_GAP   = 0.18;  // source top-1 must beat top-2 by this
const MIN_POSITIVE_SCORE    = 0.01;  // at least one positive signal must have fired
const HIGH_TARGET_MIN_SCORE = 0.01;  // target must have at least one signal

/**
 * Rank ALL parts and groups in the scene as potential source candidates,
 * and ALL non-source parts as potential target candidates.
 *
 * Works without a pre-selected partId — applies every available signal:
 * selection, group membership, name in text, deictic+recentReferent,
 * sole-remaining-target bonus.
 *
 * Returns the top-4 source and top-4 target candidates sorted by score.
 */
export function rankAllCandidates(
  text: string,
  ctx: RouterContext,
): {
  sourceCandidates: EntityResolutionCandidate[];
  targetCandidates: EntityResolutionCandidate[];
  usedSelectionSignal: boolean;
  usedRecentReferent: boolean;
} {
  const groups = ctx.groups ?? [];
  const deictic = hasDicticLanguage(text);
  const recentSource = ctx.recentReferents?.lastSource ?? null;
  const recentTarget = ctx.recentReferents?.lastTarget ?? null;

  let usedRecentReferent = false;
  const usedSelectionSignal =
    ctx.selectionPartId != null || (ctx.multiSelectIds?.length ?? 0) > 0;

  // ── Source candidates ────────────────────────────────────────────────────

  const rawSourceCandidates: EntityResolutionCandidate[] = [];

  // Score every group
  for (const group of groups) {
    const cand = buildGroupCandidate(group, text, ctx);
    // Deictic + recent referent
    if (deictic && recentSource && recentSource.entityId === group.id) {
      cand.score += ENTITY_SCORE.recentReferentBonus;
      cand.signals.push(`recentReferentBonus(+${ENTITY_SCORE.recentReferentBonus})`);
      usedRecentReferent = true;
    }
    rawSourceCandidates.push(cand);
  }

  // Score every part
  for (const part of ctx.parts) {
    const cand = buildPartCandidate(part, text, ctx);
    const owningGroups = groups.filter((g) => g.partIds.includes(part.id));
    if (owningGroups.length > 0) applyChildNameBonus(cand, text);
    // Deictic + recent referent
    if (deictic && recentSource && recentSource.entityId === part.id) {
      cand.score += ENTITY_SCORE.recentReferentBonus;
      cand.signals.push(`recentReferentBonus(+${ENTITY_SCORE.recentReferentBonus})`);
      usedRecentReferent = true;
    }
    rawSourceCandidates.push(cand);
  }

  rawSourceCandidates.sort((a, b) => b.score - a.score);
  const sourceCandidates = rawSourceCandidates.slice(0, 4);
  const sourceMemberIds = new Set(sourceCandidates[0]?.memberPartIds ?? []);

  // ── Target candidates ────────────────────────────────────────────────────

  const rawTargetCandidates: EntityResolutionCandidate[] = ctx.parts
    .filter((p) => !sourceMemberIds.has(p.id))
    .map((p) => {
      const cand = buildPartCandidate(p, text, ctx);
      // Deictic + recent target referent
      if (deictic && recentTarget && recentTarget.entityId === p.id) {
        cand.score += ENTITY_SCORE.recentReferentBonus;
        cand.signals.push(`recentReferentBonus(+${ENTITY_SCORE.recentReferentBonus})`);
        usedRecentReferent = true;
      }
      return cand;
    });

  // Sole-remaining-target bonus: if only 1 valid target remains, it's likely the target
  if (rawTargetCandidates.length === 1 && rawTargetCandidates[0]) {
    rawTargetCandidates[0].score += ENTITY_SCORE.soleRemainingTargetBonus;
    rawTargetCandidates[0].signals.push(`soleRemainingTargetBonus(+${ENTITY_SCORE.soleRemainingTargetBonus})`);
  }

  rawTargetCandidates.sort((a, b) => b.score - a.score);
  const targetCandidates = rawTargetCandidates.slice(0, 4);

  return { sourceCandidates, targetCandidates, usedSelectionSignal, usedRecentReferent };
}

// ---------------------------------------------------------------------------
// Targeted clarification question generator
// ---------------------------------------------------------------------------

function buildTargetedClarification(
  ambiguityType: AmbiguityType | null,
  sourceCandidates: EntityResolutionCandidate[],
  targetCandidates: EntityResolutionCandidate[],
): string {
  const src1 = sourceCandidates[0];
  const src2 = sourceCandidates[1];
  const tgt1 = targetCandidates[0];
  const tgt2 = targetCandidates[1];

  switch (ambiguityType) {
    case 'part_vs_group': {
      const groupCand = [src1, src2].find((c) => c?.entityType === 'group');
      const partCand  = [src1, src2].find((c) => c?.entityType === 'part');
      if (groupCand && partCand) {
        return `你說的「${partCand.displayName}」，是單一零件，還是目前的「${groupCand.displayName}」模組？`;
      }
      break;
    }
    case 'multiple_source_peers': {
      if (src1 && src2) {
        return `我找到兩個可能的來源：「${src1.displayName}」、「${src2.displayName}」。你要哪一個？`;
      }
      break;
    }
    case 'multiple_target_peers': {
      if (tgt1 && tgt2) {
        return `目標不確定，找到兩個可能：「${tgt1.displayName}」、「${tgt2.displayName}」。你要裝到哪一個上？`;
      }
      break;
    }
    case 'target_unclear': {
      const srcLabel = src1 ? `「${src1.displayName}」` : '這個零件';
      const suggestions = targetCandidates
        .filter((c) => c.score >= 0)
        .slice(0, 3)
        .map((c) => `「${c.displayName}」`)
        .join('、');
      if (suggestions) {
        return `你要把 ${srcLabel} 裝到哪個零件上？（場景中有：${suggestions}）`;
      }
      return `你要把 ${srcLabel} 裝到哪個零件上？`;
    }
    case 'source_unclear': {
      const suggestions = sourceCandidates
        .filter((c) => c.score >= 0)
        .slice(0, 3)
        .map((c) => `「${c.displayName}」`)
        .join('、');
      if (suggestions) {
        return `你想組裝哪個零件或模組？（場景中有：${suggestions}）`;
      }
      return '你想組裝哪個零件或模組？請告訴我來源零件名稱。';
    }
    case 'both_unclear':
    default:
      return '請告訴我你想組裝哪兩個零件或模組（例如：「把 A 裝到 B 上」）。';
  }
  return '請告訴我來源和目標零件，我才能繼續。';
}

// ---------------------------------------------------------------------------
// Confidence assessment
// ---------------------------------------------------------------------------

/**
 * Full confidence assessment for an assembly utterance.
 *
 * Confidence states:
 *   HIGH   — top source beats runner by ≥ HIGH_CONFIDENCE_GAP and target
 *             has a positive score (or sole remaining target). → execute.
 *   MEDIUM — source is identifiable but target is unclear, or small gap between
 *             top candidates. → ask targeted clarification.
 *   LOW    — source cannot be identified at all. → ask user to specify.
 *
 * @param text             Full utterance
 * @param ctx              RouterContext (includes recentReferents)
 * @param normalizedIntent 'mount' | 'mount_to_target' | 'insert' | 'cover' | 'default'
 */
export function assessConfidence(
  text: string,
  ctx: RouterContext,
  normalizedIntent = 'default',
): ConfidenceAssessment {
  const diagnostics: string[] = [];
  const { sourceCandidates, targetCandidates, usedSelectionSignal, usedRecentReferent } =
    rankAllCandidates(text, ctx);

  const srcTop    = sourceCandidates[0] ?? null;
  const srcRunner = sourceCandidates[1] ?? null;
  const tgtTop    = targetCandidates[0] ?? null;
  const tgtRunner = targetCandidates[1] ?? null;

  const srcGap = srcTop && srcRunner
    ? srcTop.score - srcRunner.score
    : srcTop ? Infinity : 0;
  const tgtGap = tgtTop && tgtRunner
    ? tgtTop.score - tgtRunner.score
    : tgtTop ? Infinity : 0;

  const srcOk = srcTop != null && srcTop.score > MIN_POSITIVE_SCORE;
  const tgtOk = tgtTop != null && tgtTop.score > HIGH_TARGET_MIN_SCORE;

  diagnostics.push(
    `src top=${srcTop?.displayName}(${srcTop?.score.toFixed(2)}) runner=${srcRunner?.displayName}(${srcRunner?.score.toFixed(2) ?? 'none'}) gap=${srcGap === Infinity ? '∞' : srcGap.toFixed(2)}`,
    `tgt top=${tgtTop?.displayName}(${tgtTop?.score.toFixed(2)}) runner=${tgtRunner?.displayName}(${tgtRunner?.score.toFixed(2) ?? 'none'}) gap=${tgtGap === Infinity ? '∞' : tgtGap.toFixed(2)}`,
    `usedSelection=${usedSelectionSignal} usedReferent=${usedRecentReferent}`,
  );

  let state: ConfidenceState;
  let ambiguityType: AmbiguityType | null = null;

  if (!srcOk && !tgtOk) {
    state = 'low';
    ambiguityType = 'both_unclear';
  } else if (!srcOk) {
    state = 'low';
    ambiguityType = 'source_unclear';
  } else if (!tgtOk) {
    // Source is identifiable, target is not → MEDIUM (ask which target)
    state = 'medium';
    ambiguityType = 'target_unclear';
  } else if (srcGap >= HIGH_CONFIDENCE_GAP && tgtGap >= HIGH_CONFIDENCE_GAP) {
    state = 'high';
  } else {
    state = 'medium';
    // Classify the ambiguity type
    if (srcGap < HIGH_CONFIDENCE_GAP && srcTop && srcRunner &&
        srcTop.entityType !== srcRunner.entityType) {
      ambiguityType = 'part_vs_group';
    } else if (srcGap < HIGH_CONFIDENCE_GAP) {
      ambiguityType = 'multiple_source_peers';
    } else {
      ambiguityType = 'multiple_target_peers';
    }
  }

  const clarificationQuestion =
    state !== 'high' ? buildTargetedClarification(ambiguityType, sourceCandidates, targetCandidates) : null;

  const confidenceSummary = [
    `state=${state}`,
    ambiguityType ? `ambiguity=${ambiguityType}` : '',
    `src=${srcTop?.displayName ?? 'none'}(${srcTop?.score.toFixed(2) ?? '0'})`,
    `tgt=${tgtTop?.displayName ?? 'none'}(${tgtTop?.score.toFixed(2) ?? '0'})`,
    `gap_src=${srcGap === Infinity ? '∞' : srcGap.toFixed(2)}`,
    `gap_tgt=${tgtGap === Infinity ? '∞' : tgtGap.toFixed(2)}`,
  ].filter(Boolean).join(' ');

  diagnostics.push(`confidenceSummary: ${confidenceSummary}`);

  return {
    state,
    sourceCandidates,
    targetCandidates,
    normalizedIntent,
    ambiguityType,
    clarificationQuestion,
    confidenceSummary,
    usedSelectionSignal,
    usedRecentReferent,
    diagnostics,
  };
}

/**
 * Build mate args from a HIGH-confidence assessment result.
 * Returns null if the assessment is not high confidence.
 */
export function buildMateArgsFromAssessment(
  assessment: ConfidenceAssessment,
): Record<string, unknown> | null {
  if (assessment.state !== 'high') return null;

  const srcTop = assessment.sourceCandidates[0];
  const tgtTop = assessment.targetCandidates[0];
  if (!srcTop || !tgtTop) return null;

  const repPartId = srcTop.memberPartIds[0];
  if (!repPartId) return null;

  const targetPartId = tgtTop.entityType === 'part'
    ? tgtTop.entityId
    : tgtTop.memberPartIds[0];
  if (!targetPartId) return null;

  return {
    sourcePart: { partId: repPartId },
    targetPart: { partId: targetPartId },
    ...(srcTop.entityType === 'group' ? { sourceGroupId: srcTop.entityId } : {}),
  };
}
