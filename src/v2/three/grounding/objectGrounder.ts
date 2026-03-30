/**
 * objectGrounder.ts — Natural language object grounding for assembly commands.
 *
 * Maps user utterance → resolved source/target part candidates.
 *
 * Strategy (Method A: VLM-first):
 *   1. Parse utterance into GroundingConcepts (source/target concepts + intent)
 *   2. Check for deictic references ("這個", "this") → use selection
 *   3. Match concepts against VLM semantic cards in registry
 *   4. Score candidates
 *   5. If ambiguous → return clarification question
 *   6. If resolved → return top candidates
 *
 * Selection fallback:
 *   When user says "這個"/"這兩個"/"this"/"these", prefer currently selected parts.
 */
import type { GroundingConcepts, PartGroundingCandidate, GroundingResult } from './partSemanticTypes';
import { findPartsByText, getAllCards } from './partSemanticRegistry';

// ── Deictic detection ─────────────────────────────────────────────────────────

const DEICTIC_PATTERNS = [
  /這個|這顆|這塊|這片|這條|這根|這套|這組/,
  /這兩個|這兩顆|這兩塊|這幾個/,
  /this one|these two|these parts|this part/i,
];

function isDeictic(text: string): boolean {
  return DEICTIC_PATTERNS.some(p => p.test(text));
}

// ── Intent classification from text ──────────────────────────────────────────

const ASSEMBLY_VERBS: Record<string, string> = {
  '裝到|安裝|組裝|裝上|裝配|組合|接合|固定|對齊': 'mount',
  '插入|插進|裝進|嵌入': 'insert',
  '蓋上|蓋住|覆蓋': 'cover',
  '鎖上|鎖緊|鎖': 'screw',
  'mate|assemble|attach|mount|install|connect|join': 'mount',
  'insert|plug in|fit into': 'insert',
  'cover|close|cap': 'cover',
};

function detectIntent(text: string): string {
  const lower = text.toLowerCase();
  for (const [pattern, intent] of Object.entries(ASSEMBLY_VERBS)) {
    if (new RegExp(pattern, 'i').test(lower)) return intent;
  }
  return 'default';
}

// ── Concept extraction (simple heuristic + LLM fallback) ─────────────────────

/**
 * Very simple heuristic concept extraction.
 * For better results, this can be enhanced with an LLM call.
 *
 * Pattern: "把[SOURCE]裝到[TARGET]上" / "將[SOURCE]安裝到[TARGET]"
 * Or: "把這兩個零件組起來" → deictic, both parts from selection
 */
function extractConceptsHeuristic(text: string): GroundingConcepts {
  const usesDeictic = isDeictic(text);
  const intent = detectIntent(text);

  // Pattern: 把X裝到Y / 將X安裝到Y上
  const baPattern = /[把將]\s*(.+?)\s*[裝安組接固對](?:[到至上]|進|上)\s*(.+?)(?:上|$)/;
  const m = text.match(baPattern);
  if (m) {
    return {
      sourceConcept: m[1].trim(),
      targetConcept: m[2].trim(),
      assemblyIntent: intent,
      utteranceType: usesDeictic ? 'deictic' : 'conceptual',
      usesDeictic,
    };
  }

  // English pattern: "attach X to Y" / "mount X on Y"
  const enPattern = /(?:attach|mount|install|connect|mate|assemble)\s+(.+?)\s+(?:to|on|onto|into)\s+(.+)/i;
  const em = text.match(enPattern);
  if (em) {
    return {
      sourceConcept: em[1].trim(),
      targetConcept: em[2].trim(),
      assemblyIntent: intent,
      utteranceType: usesDeictic ? 'deictic' : 'conceptual',
      usesDeictic,
    };
  }

  // All deictic, no explicit names
  if (usesDeictic) {
    return {
      assemblyIntent: intent,
      utteranceType: 'deictic',
      usesDeictic: true,
    };
  }

  // Try to find any object-like words
  return {
    assemblyIntent: intent,
    utteranceType: 'unknown',
    usesDeictic: false,
  };
}

// ── Clarification generation ──────────────────────────────────────────────────

function buildClarificationQuestion(
  role: 'source' | 'target',
  concept: string,
  candidates: PartGroundingCandidate[]
): string {
  const roleZh = role === 'source' ? '要移動的零件' : '固定的目標零件';
  const names = candidates.slice(0, 4).map(c => c.partName).join('、');
  const conceptStr = concept ? `"${concept}"` : '';
  return `我找到${candidates.length}個可能的${conceptStr}候選：${names}。你要哪一個作為${roleZh}？`;
}

// ── Main grounding function ───────────────────────────────────────────────────

const CLARIFICATION_THRESHOLD = 2;   // ask if >= this many similar-score candidates
const MIN_SCORE_THRESHOLD = 0.10;    // ignore candidates below this score
const AMBIGUITY_GAP = 0.15;          // if top-2 differ by less than this, consider ambiguous

export type GroundingOptions = {
  /** IDs of currently selected parts in the UI */
  selectedPartIds?: string[];
  /** LLM-parsed concepts (if already available from router) */
  parsedConcepts?: Partial<GroundingConcepts>;
};

export function groundObjects(utterance: string, options: GroundingOptions = {}): GroundingResult {
  const diagnostics: string[] = [];
  const selectedSet = new Set(options.selectedPartIds ?? []);
  const allCards = getAllCards();

  diagnostics.push(`Registry has ${allCards.length} parts (${allCards.filter(c => c.vlmCategory).length} labeled by VLM)`);

  // Parse concepts
  const concepts = options.parsedConcepts
    ? { ...extractConceptsHeuristic(utterance), ...options.parsedConcepts }
    : extractConceptsHeuristic(utterance);

  diagnostics.push(`Utterance type: ${concepts.utteranceType}, intent: ${concepts.assemblyIntent}`);
  if (concepts.sourceConcept) diagnostics.push(`Source concept: "${concepts.sourceConcept}"`);
  if (concepts.targetConcept) diagnostics.push(`Target concept: "${concepts.targetConcept}"`);

  const usedVlmRegistry = allCards.some(c => c.vlmCategory !== undefined);
  let usedSelectionFallback = false;

  // ── Deictic handling ──────────────────────────────────────────────────────

  if (concepts.usesDeictic && selectedSet.size > 0) {
    usedSelectionFallback = true;
    const selectedCards = allCards.filter(c => selectedSet.has(c.partId));
    diagnostics.push(`Deictic reference: using ${selectedCards.length} selected parts`);

    if (selectedCards.length >= 2) {
      // Two selected → auto-assign source and target
      const src: PartGroundingCandidate = {
        partId: selectedCards[0].partId,
        partName: selectedCards[0].partName,
        semanticLabel: selectedCards[0].vlmCategory ?? selectedCards[0].partName,
        score: 1.0,
        reason: 'selected in UI (deictic)',
        matchedSignals: ['selection', 'deictic'],
      };
      const tgt: PartGroundingCandidate = {
        partId: selectedCards[1].partId,
        partName: selectedCards[1].partName,
        semanticLabel: selectedCards[1].vlmCategory ?? selectedCards[1].partName,
        score: 1.0,
        reason: 'selected in UI (deictic)',
        matchedSignals: ['selection', 'deictic'],
      };
      return {
        sourceCandidates: [src],
        targetCandidates: [tgt],
        needsClarification: false,
        usedSelectionFallback: true,
        usedVlmRegistry,
        diagnostics,
      };
    }

    if (selectedCards.length === 1) {
      // One selected → use as source, ask for target
      const src: PartGroundingCandidate = {
        partId: selectedCards[0].partId,
        partName: selectedCards[0].partName,
        semanticLabel: selectedCards[0].vlmCategory ?? selectedCards[0].partName,
        score: 1.0,
        reason: 'selected in UI',
        matchedSignals: ['selection', 'deictic'],
      };
      return {
        sourceCandidates: [src],
        targetCandidates: [],
        needsClarification: true,
        clarificationQuestion: `已選取 "${selectedCards[0].partName}" 作為來源零件。請指定要組裝到哪個目標零件？`,
        usedSelectionFallback: true,
        usedVlmRegistry,
        diagnostics,
      };
    }
  }

  // ── Semantic registry search ──────────────────────────────────────────────

  let sourceRaw: ReturnType<typeof findPartsByText> = [];
  let targetRaw: ReturnType<typeof findPartsByText> = [];

  if (concepts.sourceConcept) {
    sourceRaw = findPartsByText(concepts.sourceConcept, selectedSet)
      .filter(c => c.score >= MIN_SCORE_THRESHOLD);
    diagnostics.push(`Source "${concepts.sourceConcept}": ${sourceRaw.length} candidates`);
  }

  if (concepts.targetConcept) {
    targetRaw = findPartsByText(concepts.targetConcept, selectedSet)
      .filter(c => c.score >= MIN_SCORE_THRESHOLD);
    diagnostics.push(`Target "${concepts.targetConcept}": ${targetRaw.length} candidates`);
  }

  // ── No concept extraction → try all parts with selection ─────────────────

  if (!concepts.sourceConcept && !concepts.targetConcept) {
    if (selectedSet.size >= 2) {
      usedSelectionFallback = true;
      const sel = allCards.filter(c => selectedSet.has(c.partId)).slice(0, 2);
      return {
        sourceCandidates: [toCandidate(sel[0])],
        targetCandidates: [toCandidate(sel[1])],
        needsClarification: false,
        usedSelectionFallback: true,
        usedVlmRegistry,
        diagnostics: [...diagnostics, 'No concepts extracted; used 2 selected parts'],
      };
    }
    return {
      sourceCandidates: [],
      targetCandidates: [],
      needsClarification: true,
      clarificationQuestion: '請問你想要組裝哪兩個零件？你可以選取它們或告訴我它們的名稱。',
      usedSelectionFallback: false,
      usedVlmRegistry,
      diagnostics: [...diagnostics, 'No concepts extracted and no selection available'],
    };
  }

  // ── Convert to PartGroundingCandidate ────────────────────────────────────

  const sourceCandidates: PartGroundingCandidate[] = sourceRaw.map(r => ({
    partId: r.partId,
    partName: r.partName,
    semanticLabel: r.semanticLabel,
    score: r.score,
    reason: r.reason,
    matchedSignals: r.matchedSignals as PartGroundingCandidate['matchedSignals'],
  }));

  const targetCandidates: PartGroundingCandidate[] = targetRaw.map(r => ({
    partId: r.partId,
    partName: r.partName,
    semanticLabel: r.semanticLabel,
    score: r.score,
    reason: r.reason,
    matchedSignals: r.matchedSignals as PartGroundingCandidate['matchedSignals'],
  }));

  // ── Ambiguity check ────────────────────────────────────────────────────────

  const srcAmbiguous = isAmbiguous(sourceCandidates);
  const tgtAmbiguous = isAmbiguous(targetCandidates);
  const needsClarification = srcAmbiguous || tgtAmbiguous || sourceCandidates.length === 0 || targetCandidates.length === 0;

  let clarificationQuestion: string | undefined;
  if (needsClarification) {
    if (sourceCandidates.length === 0 && concepts.sourceConcept) {
      clarificationQuestion = `我找不到符合"${concepts.sourceConcept}"的零件。請告訴我更多細節或直接選取零件。`;
    } else if (srcAmbiguous && concepts.sourceConcept) {
      clarificationQuestion = buildClarificationQuestion('source', concepts.sourceConcept, sourceCandidates);
    } else if (targetCandidates.length === 0 && concepts.targetConcept) {
      clarificationQuestion = `我找不到符合"${concepts.targetConcept}"的零件。請告訴我更多細節或直接選取目標零件。`;
    } else if (tgtAmbiguous && concepts.targetConcept) {
      clarificationQuestion = buildClarificationQuestion('target', concepts.targetConcept ?? '', targetCandidates);
    } else {
      clarificationQuestion = '請問你想要組裝哪兩個零件？你可以選取它們或告訴我它們的名稱。';
    }
  }

  return {
    sourceCandidates: sourceCandidates.slice(0, 5),
    targetCandidates: targetCandidates.slice(0, 5),
    needsClarification,
    clarificationQuestion,
    usedSelectionFallback,
    usedVlmRegistry,
    diagnostics,
  };
}

function isAmbiguous(candidates: PartGroundingCandidate[]): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length === 1) return false;
  if (candidates.length >= CLARIFICATION_THRESHOLD) {
    // Ambiguous if top-2 scores are close
    const gap = candidates[0].score - candidates[1].score;
    return gap < AMBIGUITY_GAP;
  }
  return false;
}

function toCandidate(card: import('./partSemanticTypes').PartSemanticCard): PartGroundingCandidate {
  return {
    partId: card.partId,
    partName: card.partName,
    semanticLabel: card.vlmCategory ?? card.partName,
    score: 1.0,
    reason: 'selected in UI',
    matchedSignals: ['selection'],
  };
}
