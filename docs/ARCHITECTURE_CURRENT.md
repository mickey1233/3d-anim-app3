# Assembly Architecture — Current State

## 3-Layer Architecture

### Layer 1: VLM Semantic Description
**File**: `mcp-server/v2/vlm/semanticDescriber.ts`

Produces `AssemblySemanticDescription`:
- `sourceRole`, `targetRole` — part semantic roles (lid/body/bracket/…)
- `assemblyIntent` — insert/cover/mount/slide/screw/snap/default
- `relationship` — natural language (e.g. "fan mounts onto side panel")
- `likelyContactRegions`, `likelyApproachDirection` — geometry hints
- `preferredSolverHints` — solver families VLM suggests
- `confidence` — 0–1

**Status**: Implemented. Failure-safe (returns null when VLM unavailable).
**Important**: VLM DESCRIBES; it does NOT compute transforms.

---

### Layer 2: Solver Scoring Framework
**File**: `src/v2/three/mating/solverScoring.ts`

Input signals:
1. Feature extraction results (geometry types, counts)
2. Existing mating candidates (scored pairs)
3. VLM semantic description (intent, solver hints)
4. Demonstration priors (from mateRecipes.ts)
5. Recipe priors (exact part-pair cache)

Output: `SolverScoringResult` with ranked `SolverScore[]`, each having:
- `solver` — solver family name
- `totalScore` — 0–1
- `components` — one score per signal (for debugging / model replacement)
- `reasons` — human-readable explanation
- `implemented` — whether solver is fully implemented

Score components (weights):
- `geometryCompatibility` (0.28) — feature types present
- `featureCompatibility` (0.24) — scored candidate patterns
- `semanticIntentMatch` (0.24) — VLM intent/hints
- `demonstrationPrior` (0.14) — keyword/feature-type matching from demos
- `recipePrior` (0.05) — exact recipe match signal
- `symmetryResolutionGain` (0.03) — future
- `insertionAxisConfidence` (0.02) — future

**Status**: Heuristic scorer. Structured for future learned-model replacement.

---

### Layer 3: Geometry Solver
**File**: `src/v2/three/mating/featureSolver.ts`

Implemented solver families:
- `plane_align` — planar face flush
- `peg_hole` — single peg/hole insertion
- `pattern_align` — multi-point Kabsch SVD alignment

Planned (not implemented): `slot_insert`, `rim_align`, `rail_slide`

Output contract: `AlignmentSolution` with `solutionType: 'absolute_world'`

---

## Data Flow

```
User chat command
  → Router Agent (agentProvider.ts / agentLlm.ts)
  → action.smart_mate_execute (legacy face-based) OR query.generate_candidates (feature-based)

[Feature-based path — query.generate_candidates]
  → Feature extraction (featureExtractor.ts)
  → Demo priors fetch (agent.find_relevant_demonstrations → mateRecipes.ts)
  → [Optional] VLM semantic description (semanticDescriber.ts)       [Layer 1]
  → Solver scoring (solverScoring.ts)                                 [Layer 2]
  → Candidate generation (featureMatcher.ts) with demo prior boosts
  → Geometry solver per candidate (featureSolver.ts)                  [Layer 3]
  → Feasibility check (estimateInsertionFeasibility)
  → Return candidates + solverRecommendation + diagnostics
  → [Optional] VLM rerank (agent.vlm_rerank_candidates)
  → action.apply_candidate → transform applied
  → Human correction → mate.record_demonstration → learning

[Legacy face-based path — still working]
  → mateParamsInfer.ts → LLM infers source/target face
  → structuredMate.ts → VLM multi-view analysis
  → solver.ts → face-flush / insert-arc transform
```

---

## Shared Types

All cross-layer types: `shared/schema/assemblySemanticTypes.ts`
- `DemonstrationPriorScore` — demo relevance score (server ↔ WS ↔ browser)
- `AssemblySemanticDescription` — Layer 1 output
- `SolverScoringResult`, `SolverScore` — Layer 2 output
- `SolverFamily`, `PartRole`, `AssemblyIntent` — enums

---

## Current Limitations

See `docs/CURRENT_LIMITATIONS.md`
