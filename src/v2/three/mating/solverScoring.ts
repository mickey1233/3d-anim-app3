/**
 * solverScoring.ts — Solver family scoring framework (Layer 2 of 3).
 *
 * Given geometry features, VLM semantics, and demonstration priors,
 * scores each solver family and returns a ranked list.
 *
 * Design principles:
 * - One score component per signal (replaceable by learned model later)
 * - No giant if/else trees — each scorer returns a Record<SolverFamily, number>
 * - Failure-safe: missing signals → their score components = 0
 *
 * NOT responsible for:
 * - Computing transforms (→ featureSolver.ts)
 * - Calling VLM (→ semanticDescriber.ts)
 * - Storing demonstrations (→ mateRecipes.ts)
 */

import type {
  SolverFamily, SolverScore, SolverScoringResult,
  SolverScoreComponent, AssemblySemanticDescription, DemonstrationPriorScore,
} from '../../../../shared/schema/assemblySemanticTypes';
import type { AssemblyFeature, MatingCandidate } from './featureTypes';

export type SolverScoringInput = {
  sourceFeatures: AssemblyFeature[];
  targetFeatures: AssemblyFeature[];
  semanticDescription?: AssemblySemanticDescription | null;
  demonstrationPriors?: DemonstrationPriorScore[];
  recipePriorSourceFace?: string;
  recipePriorTargetFace?: string;
  existingCandidates?: MatingCandidate[];
  geometrySummary?: {
    sourceBboxSize?: [number, number, number];
    targetBboxSize?: [number, number, number];
    relativePosition?: { dx: number; dy: number; dz: number };
  };
};

const ALL_SOLVERS: SolverFamily[] = ['plane_align','peg_hole','pattern_align','slot_insert','rim_align','rail_slide'];
const IMPLEMENTED_SOLVERS = new Set<SolverFamily>(['plane_align','peg_hole','pattern_align']);

// Weights for combining score components (must sum to 1)
const WEIGHTS: Record<keyof SolverScoreComponent, number> = {
  geometryCompatibility:  0.28,
  featureCompatibility:   0.24,
  semanticIntentMatch:    0.24,
  demonstrationPrior:     0.14,
  recipePrior:            0.05,
  symmetryResolutionGain: 0.03,
  insertionAxisConfidence:0.02,
};

// ── Score component functions ──────────────────────────────────────────────

function scoreGeometry(input: SolverScoringInput): Record<SolverFamily, number> {
  const r = zeroScores();
  const src = new Set(input.sourceFeatures.map(f => f.type));
  const tgt = new Set(input.targetFeatures.map(f => f.type));

  if (src.has('planar_face') && tgt.has('planar_face')) r.plane_align = 0.5;

  const hasPeg  = src.has('peg') || tgt.has('peg');
  const hasHole = src.has('cylindrical_hole') || tgt.has('cylindrical_hole') || src.has('blind_hole') || tgt.has('blind_hole');
  if (hasPeg && hasHole) r.peg_hole = 0.7;

  const srcHoles = input.sourceFeatures.filter(f => f.type === 'cylindrical_hole' || f.type === 'blind_hole').length;
  const tgtHoles = input.targetFeatures.filter(f => f.type === 'cylindrical_hole' || f.type === 'blind_hole').length;
  if (srcHoles >= 2 && tgtHoles >= 2) {
    r.pattern_align = Math.min(1, 0.35 + 0.08 * Math.min(srcHoles, tgtHoles));
  }

  const hasSlot = src.has('slot') || tgt.has('slot');
  const hasTab  = src.has('tab')  || tgt.has('tab');
  if (hasSlot) r.slot_insert = hasTab ? 0.7 : 0.4;

  const hasRail = src.has('rail') || tgt.has('rail');
  if (hasRail) r.rail_slide = 0.7;

  r.rim_align = 0.05; // very low without explicit rim features
  return r;
}

function scoreFeatures(input: SolverScoringInput): Record<SolverFamily, number> {
  const r = zeroScores();
  if (!input.existingCandidates?.length) return r;

  for (const cand of input.existingCandidates) {
    for (const pair of cand.featurePairs) {
      const { sourceFeature: sf, targetFeature: tf } = pair;
      const w = cand.totalScore;

      if (sf.type === 'planar_face' && tf.type === 'planar_face')
        r.plane_align = Math.max(r.plane_align, w * 0.8);

      const isPegHole =
        (sf.type === 'peg' && (tf.type === 'cylindrical_hole' || tf.type === 'blind_hole')) ||
        (tf.type === 'peg' && (sf.type === 'cylindrical_hole' || sf.type === 'blind_hole'));
      if (isPegHole) r.peg_hole = Math.max(r.peg_hole, w);
    }

    if (cand.featurePairs.length >= 2) {
      const allPegsOrHoles = cand.featurePairs.every(p =>
        ['cylindrical_hole','blind_hole','peg'].includes(p.sourceFeature.type) ||
        ['cylindrical_hole','blind_hole','peg'].includes(p.targetFeature.type)
      );
      if (allPegsOrHoles) r.pattern_align = Math.max(r.pattern_align, cand.totalScore);
    }
  }
  return r;
}

function scoreSemantic(input: SolverScoringInput): Record<SolverFamily, number> {
  const r = zeroScores();
  const sd = input.semanticDescription;
  if (!sd) return r;

  for (const hint of sd.preferredSolverHints) {
    if (hint in r) r[hint] = Math.min(1, r[hint] + 0.4);
  }

  const boosts: Partial<Record<AssemblySemanticDescription['assemblyIntent'], Partial<Record<SolverFamily, number>>>> = {
    insert: { peg_hole: 0.3, slot_insert: 0.2 },
    cover:  { plane_align: 0.3, rim_align: 0.2 },
    mount:  { pattern_align: 0.3, plane_align: 0.2 },
    slide:  { slot_insert: 0.3, rail_slide: 0.3 },
    screw:  { peg_hole: 0.2, pattern_align: 0.2 },
    snap:   { peg_hole: 0.2, rim_align: 0.15 },
  };
  const intentBoost = boosts[sd.assemblyIntent] ?? {};
  for (const [solver, boost] of Object.entries(intentBoost)) {
    r[solver as SolverFamily] = Math.min(1, r[solver as SolverFamily] + (boost ?? 0));
  }

  for (const k of ALL_SOLVERS) r[k] = Math.min(1, r[k] * (0.4 + sd.confidence * 0.6));
  return r;
}

function scoreDemoPriors(input: SolverScoringInput): Record<SolverFamily, number> {
  const r = zeroScores();
  if (!input.demonstrationPriors?.length) return r;

  const KEYWORDS: Record<SolverFamily, string[]> = {
    pattern_align: ['pattern','hole','bolt','mount','pcb'],
    peg_hole:      ['peg','pin','insert','plug','snap'],
    plane_align:   ['plane','flat','face','flush','cover'],
    slot_insert:   ['slot','groove','pocket','slide','tray'],
    rim_align:     ['rim','ring','circular','lid','cap'],
    rail_slide:    ['rail','slide','glide','track','chassis'],
  };

  for (const prior of input.demonstrationPriors.slice(0, 3)) {
    const text = (prior.generalizedRuleSummary ?? '').toLowerCase();
    const w = prior.totalScore;

    for (const [solver, keywords] of Object.entries(KEYWORDS)) {
      const matches = keywords.filter(kw => text.includes(kw)).length;
      if (matches > 0) r[solver as SolverFamily] = Math.min(1, r[solver as SolverFamily] + (matches / keywords.length) * 0.35 * w);
    }

    // Feature type hint boost
    for (const ft of prior.matchedFeatureTypes) {
      if (ft === 'cylindrical_hole' || ft === 'blind_hole') r.pattern_align = Math.min(1, r.pattern_align + 0.1 * w);
      if (ft === 'peg') r.peg_hole = Math.min(1, r.peg_hole + 0.1 * w);
      if (ft === 'slot') r.slot_insert = Math.min(1, r.slot_insert + 0.1 * w);
      if (ft === 'planar_face') r.plane_align = Math.min(1, r.plane_align + 0.05 * w);
    }
  }
  return r;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function zeroScores(): Record<SolverFamily, number> {
  return { plane_align: 0, peg_hole: 0, pattern_align: 0, slot_insert: 0, rim_align: 0, rail_slide: 0 };
}

export function scoreSolvers(input: SolverScoringInput): SolverScoringResult {
  const geo  = scoreGeometry(input);
  const feat = scoreFeatures(input);
  const sem  = scoreSemantic(input);
  const demo = scoreDemoPriors(input);

  const rankedSolvers: SolverScore[] = ALL_SOLVERS.map(solver => {
    const components: SolverScoreComponent = {
      geometryCompatibility:   geo[solver]  ?? 0,
      featureCompatibility:    feat[solver] ?? 0,
      semanticIntentMatch:     sem[solver]  ?? 0,
      demonstrationPrior:      demo[solver] ?? 0,
      recipePrior:             0,
      symmetryResolutionGain:  0,
      insertionAxisConfidence: 0,
    };

    const total = Math.min(1,
      components.geometryCompatibility   * WEIGHTS.geometryCompatibility +
      components.featureCompatibility    * WEIGHTS.featureCompatibility +
      components.semanticIntentMatch     * WEIGHTS.semanticIntentMatch +
      components.demonstrationPrior      * WEIGHTS.demonstrationPrior +
      components.recipePrior             * WEIGHTS.recipePrior +
      components.symmetryResolutionGain  * WEIGHTS.symmetryResolutionGain +
      components.insertionAxisConfidence * WEIGHTS.insertionAxisConfidence
    );

    const reasons: string[] = [];
    if (components.geometryCompatibility  > 0.3) reasons.push(`geo(${components.geometryCompatibility.toFixed(2)})`);
    if (components.featureCompatibility   > 0.3) reasons.push(`feat(${components.featureCompatibility.toFixed(2)})`);
    if (components.semanticIntentMatch    > 0.2) reasons.push(`sem(${components.semanticIntentMatch.toFixed(2)})`);
    if (components.demonstrationPrior     > 0.1) reasons.push(`demo(${components.demonstrationPrior.toFixed(2)})`);

    return { solver, totalScore: total, components, reasons, implemented: IMPLEMENTED_SOLVERS.has(solver) };
  });

  rankedSolvers.sort((a, b) => {
    if (Math.abs(a.totalScore - b.totalScore) < 0.05) {
      if (a.implemented && !b.implemented) return -1;
      if (!a.implemented && b.implemented) return 1;
    }
    return b.totalScore - a.totalScore;
  });

  const top = rankedSolvers[0];
  const topImpl = rankedSolvers.find(s => s.implemented) ?? top;
  const recommended = top.totalScore > topImpl.totalScore + 0.1 ? top.solver : topImpl.solver;

  return {
    rankedSolvers,
    recommendedSolver: recommended,
    confidence: top.totalScore,
    diagnostics: [
      `recommended: ${recommended} (score=${top.totalScore.toFixed(2)})`,
      `signals: geo=${top.components.geometryCompatibility.toFixed(2)}, feat=${top.components.featureCompatibility.toFixed(2)}, sem=${top.components.semanticIntentMatch.toFixed(2)}, demo=${top.components.demonstrationPrior.toFixed(2)}`,
      ...(rankedSolvers.slice(0, 3).map(s => `  ${s.solver}: ${s.totalScore.toFixed(2)} [${s.reasons.join(', ')}]`)),
    ],
  };
}

/**
 * Derive per-solver-family scores from demonstration priors.
 * Can be used to influence solver selection even before full scoring.
 */
export function deriveSolverPriorsFromDemonstrations(
  priors: DemonstrationPriorScore[]
): Partial<Record<SolverFamily, number>> {
  return scoreDemoPriors({ sourceFeatures: [], targetFeatures: [], demonstrationPriors: priors });
}
