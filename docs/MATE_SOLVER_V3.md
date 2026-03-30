# Mate Solver v3: Feature-Based Assembly Pipeline

## Overview

The v3 pipeline introduces feature-based assembly inference as an **additive layer**
above the existing v2 face-based system. It does not replace `solveMateTopBottom` or
`resolveAnchor` — those continue to work unchanged.

---

## Pipeline Stages

```
1. Feature Extraction        featureExtractor.ts
2. Feature Matching          featureMatcher.ts
3. Candidate Generation      featureMatcher.ts
4. Alignment Solving         featureSolver.ts
5. Scoring                   featureMatcher.ts
6. (Optional) VLM Rerank     structuredMate.ts  [future]
7. Commit                    mcpToolExecutor.ts (query.generate_candidates → applyMateTransform)
```

---

## Stage 1: Feature Extraction

**Entry point**: `extractFeatures(obj: THREE.Object3D, partId: string): AssemblyFeature[]`

Calls four sub-stages:
1. `extractPlanarFaceFeatures` — wraps `clusterPlanarFaces`, emits `planar_face`
2. `extractCircleHoleFeatures` — algebraic circle fit on plane projections, emits `cylindrical_hole`
3. `extractPegFeatures` — spatial clustering above support plane + circle fit, emits `peg`
4. `extractSlotFeatures` — Level A (recess-vertex detection) + Level B (PCA fallback)

**Output**: `AssemblyFeature[]` sorted by confidence descending.

**Error handling**: Each stage catches exceptions and returns `[]`. The pipeline always returns
a valid (possibly empty) array.

---

## Stage 2: Feature Matching

**Entry point**: `generateMatingCandidates(srcFeatures, tgtFeatures, srcPartId, tgtPartId, options)`

### Step 2a: Pair Generation

For each `(source feature, target feature)` pair:
1. Look up **type compatibility score** from the compatibility table
2. Skip if type score = 0 (incompatible)
3. Check **semantic role compatibility** (insert↔receive preferred)
4. Apply **dimension gate**: if diameters are known and mismatch > combined tolerance, skip
5. Compute **dimension fit score** (Gaussian around perfect match)
6. Compute **axis alignment score** (anti-parallel for face↔face, parallel for holes)
7. Compute **face support consistency** (backward compat: source bottom ↔ target top)
8. Weighted combination → `compatibilityScore`

### Feature Type Compatibility Table

| Source | Target | Score |
|--------|--------|-------|
| peg | cylindrical_hole | 1.0 |
| tab | slot | 1.0 |
| socket | edge_connector | 1.0 |
| planar_face | planar_face | 0.9 |
| rail | slot | 0.8 |
| support_pad | planar_face | 0.7 |
| hole | hole (co-axial) | 0.4 |
| peg | peg | 0.1 |
| incompatible | incompatible | 0.0 |

### Step 2b: Candidate Assembly

Each top-scoring pair becomes the primary pair of a `MatingCandidate`.

The algorithm looks for a **secondary pair** that:
- Uses different features than the primary pair
- Has a different feature type (adds rotational constraint)

Two-pair candidates constrain both translation and in-plane rotation.

---

## Stage 3: Scoring

Each `MatingCandidate` has a `scoreBreakdown`:

| Field | Weight | Description |
|-------|--------|-------------|
| `featureCompatibility` | 0.25 | Type match quality |
| `dimensionFit` | 0.25 | How well dimensions match |
| `axisAlignment` | 0.25 | How well axes align |
| `faceSupportConsistency` | 0.15 | Backward compat: bottom↔top bonus |
| `pairCompatibility` | 0.10 | Raw pair compatibility score |
| `symmetryAmbiguityPenalty` | -0.1 max | Penalizes planar-only; reduced by 0.1*(n-1) for multi-pair |
| `collisionPenalty` | 0–1 | AABB overlap check after transform |
| `insertionFeasibility` | 0–1 | Radius compatibility for peg-hole pairs |
| `recipePrior` | 0–0.1 | Boosted by demonstration prior when topDemoScore > 0.5 |
| `vlmRerank` | 0–1 optional | Set by `agent.vlm_rerank_candidates` when `vlmRerank=true` |

`totalScore = clamp(0, 1, weighted sum - symmetryPenalty)`

---

## Stage 4: Alignment Solving

**Entry point**: `solveAlignment(sourceObj, targetObj, featurePairs, method?)`

### Solver Methods

#### `plane_align` — planar face pair
1. Compute world-space face normals
2. Rotate source so `srcNormal` becomes anti-parallel to `tgtNormal`
3. Translate rotated source center to target face center
4. Residual = |1 - (srcNormal' · targetFacing)|

#### `peg_slot` — peg↔hole pair
1. Rotate source peg axis to be anti-parallel to hole axis
2. Translate peg center to hole center
3. Residual = |pegDiameter - holeDiameter|

#### `point_align` — two feature pairs
1. Solve primary pair with `plane_align` or `peg_slot`
2. Apply primary transform to scratch copy
3. Compute in-plane rotation needed to align secondary pair centers
4. Combine: in-plane rotation × primary rotation
5. Recompute translation with combined rotation
6. Residual = distance between secondary pair centers after full transform

#### `axis_align` — generic fallback
1. Align source feature axis anti-parallel to target feature axis
2. Translate center-to-center

#### `pattern_align` — Kabsch SVD multi-point alignment (implemented 2026-03-30)
Requires ≥2 matched feature pairs (e.g. peg↔hole bolt-circle pattern).

**Algorithm (Kabsch)**:
1. Collect world positions for each source feature and corresponding target feature
2. Compute centroids (`srcC`, `tgtC`) and centered point sets (`H`, `B`)
3. Cross-covariance matrix `M = H^T B` (3×3)
4. SVD of M via 50-iteration Jacobi eigendecomposition of `M^T M`
5. Check for reflection: `d = sign(det(V * U^T))`
6. Rotation: `R = V * diag(1,1,d) * U^T`
7. Translation: `t = tgtCentroid - R * srcCentroid`
8. Residual: RMSE of aligned point pairs

**Falls back** to single-pair solve when < 2 valid pairs or decomposition fails.

**`solutionType: 'absolute_world'`**: all `AlignmentSolution` objects mark their
`translation` and `rotation` as absolute world pose (not a delta). Apply directly
as the part's new world position/quaternion.

**`patternPairCount`**: records number of pairs used (≥2 when `method='pattern_align'`).

---

## VLM Reranking

After candidate generation, VLM (vision-language model) can rerank candidates by:
1. Capturing multi-angle renders of source and target parts
2. Asking VLM to visually identify the mating features
3. Comparing VLM's description to each candidate's feature types
4. Adjusting `vlmRerank` score

VLM is NOT the primary geometry solver — it is a reranker/verifier only.
See `docs/VLM_ROLE.md`.

---

## Integration with v2

```
query.generate_candidates → returns MatingCandidate[] (descriptions + scores, no transform)

To commit:
  solveAlignment(sourceObj, targetObj, candidate.featurePairs)
  → AlignmentSolution { translation, rotation }
  applyMateTransform equivalent: apply to sourceObj
  store.setPartOverride(sourcePartId, newTransform)
```

For backward compat, the existing `action.smart_mate_execute` path is unchanged.
The feature pipeline is invoked via `query.extract_features` and `query.generate_candidates`.

---

## Known Limitations

1. **Slot detection not implemented** — only planar faces, holes, and pegs
2. **Collision detection not implemented** — `collisionPenalty` always 0
3. **Peg detection limited to Y-up parts** — pegs on non-Y faces are missed
4. **Single circle per plane** — multi-hole faces return only one hole feature
5. **No bolt-circle pattern matching** — 4-hole flanges treated as 4 independent pairs
6. **VLM reranking not integrated** — `vlmRerank` score is never set
