/**
 * groundingTypes.ts — Shared canonical types for the object grounding system.
 *
 * Grounding maps natural-language part references to actual CAD part IDs.
 *
 * Architecture:
 *   User utterance
 *   → GroundingConcepts (parsed from text)
 *   → semantic registry lookup
 *   → PartGroundingCandidate[] scored
 *   → GroundingResult (resolved or needs clarification)
 *   → assembly pipeline (featureExtractor → solverScoring → geometry solver)
 */

export type PartSemanticCard = {
  partId: string;
  partName: string;
  displayName?: string;
  /** Bounding box size summary: [width, height, depth] in scene units */
  geometrySummary: {
    bboxSize?: [number, number, number];
    featureTypes?: string[];
    featureCount?: number;
  };
  /** VLM-generated fields (absent until VLM has run) */
  vlmCategory?: string;
  /** e.g. ["fan", "blower", "cooling fan", "風扇"] */
  vlmAliases?: string[];
  /** e.g. "A square cooling fan module with mounting holes on all four corners" */
  vlmDescription?: string;
  /** e.g. ["cooling", "air_circulation", "mount_target"] */
  vlmRoles?: string[];
  /** 0–1, how confident the VLM was */
  confidence?: number;
  lastUpdatedAt?: string;
};

export type GroundingConcepts = {
  /** The concept for the source part (the one that moves), e.g. "風扇" */
  sourceConcept?: string;
  /** The concept for the target part (the fixed one), e.g. "機殼" */
  targetConcept?: string;
  /** e.g. "insert", "cover", "mount", "default" */
  assemblyIntent?: string;
  /** How the reference was expressed */
  utteranceType: 'explicit_names' | 'deictic' | 'conceptual' | 'mixed' | 'unknown';
  /** true if user said "這個", "this one", "these" etc. */
  usesDeictic: boolean;
};

export type PartGroundingCandidate = {
  partId: string;
  partName: string;
  /** Which semantic label matched */
  semanticLabel: string;
  /** 0–1 combined score */
  score: number;
  /** Human-readable reason */
  reason: string;
  /** Which signals contributed to the match */
  matchedSignals: Array<'vlm_category' | 'vlm_alias' | 'vlm_description' | 'name_token' | 'selection' | 'deictic'>;
};

export type GroundingResult = {
  sourceCandidates: PartGroundingCandidate[];
  targetCandidates: PartGroundingCandidate[];
  /** true if we need to ask the user which part */
  needsClarification: boolean;
  /** e.g. "我找到兩個可能的風扇：HOR_FAN_LEFT、HOR_FAN_RIGHT。你要哪一個？" */
  clarificationQuestion?: string;
  /** true when deictic + selection was used */
  usedSelectionFallback: boolean;
  /** true when VLM semantic cards were used */
  usedVlmRegistry: boolean;
  diagnostics: string[];
};
