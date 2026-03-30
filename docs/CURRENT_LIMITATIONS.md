# Current Limitations

Status as of 2026-03-27. Honest assessment of what works and what is heuristic/stub.

---

## Feature Extraction

### planar_face
- **Reliable.** Backed by `clusterPlanarFaces` which uses indexed triangle normals + plane clustering.
- Deduplication may miss near-identical faces across multi-mesh groups.

### cylindrical_hole
- **Heuristic.** Projects vertices near each planar cluster onto 2D, grid-clusters at 5mm,
  then runs algebraic circle fit (Pratt method).
- Works well for isolated holes with ≥6 vertices forming the circle.
- Misses: holes at oblique angles to face plane, holes not on a detected planar cluster,
  holes with radius < 3mm or > 40mm (intentionally filtered).
- Multi-hole per face: implemented. Known weak edge: holes closer than ~5mm may merge.

### slot
- **Two-level detection** implemented (2026-03-30).
- **Level A** — recess-vertex detection: finds vertices behind a support face, projects to 2D,
  grid-clusters at 3mm, emits slot if aspect ratio > 1.3 and depth > 0.5mm. Confidence ≤ 0.70.
  Guards: rejects circular clusters (could be holes), requires width > 1mm, length > 3mm.
- **Level B** — PCA elongated-face fallback: retained from original, confidence lowered to ≤ 0.35.
  Only emitted when Level A found no slot on that face.
- Circular cluster guard: linear fit RMSE vs circle fit RMSE. If circle RMSE < linear RMSE
  and inlierRatio > 0.6, cluster is treated as hole, not slot.
- Depth: Level A uses actual max recess distance. Level B still uses `width * 0.5` estimate.

### peg
- **Heuristic.** Works for any support face orientation (not just world-up).
- Requires vertices to protrude > 0.1mm beyond the support face plane.
- Cluster radius scales with face area — may fail on very small or very large faces.
- Peg height uses max projection of cluster points; may underestimate if peg tip has
  few vertices (common in low-poly models).

---

## Solver

### plane_align
- Implemented. Aligns normals anti-parallel, translates face centers together.
- Leaves in-plane position **unconstrained** (no lateral centering unless a second pair
  is provided). Correct geometrically but the result may look off-center.

### peg_slot (peg into hole)
- Implemented with insertion depth correction: peg tip aligns to hole opening.
- Rotation correction: aligns peg axis anti-parallel to hole axis.
- Known weak: if the peg feature `depth` is 0 (unknown), the tip offset is also 0,
  so it degenerates to center-to-center alignment.

### point_align (two-pair)
- Greedy sequential: primary pair first, then in-plane rotation. Not simultaneous SVD.
- Secondary constraint degeneracy path falls back to primary-only.

### pattern_align
- **Implemented** (2026-03-30). Uses Kabsch SVD on ≥2 matched feature-pair world positions.
- 3×3 SVD via Jacobi eigendecomposition of A^T A (50 iterations — reliable for 3×3).
- Reflection detection via `sign(det(V * U^T))`.
- Falls back to single-pair solve if < 2 valid pairs or Kabsch fails.
- `AlignmentSolution.solutionType = 'absolute_world'` — output is absolute world pose, not delta.
- `patternPairCount` field records how many pairs were used.

---

## Feasibility Heuristic

- Implemented via `estimateInsertionFeasibility()` in featureSolver.ts.
- Uses AABB overlap after applying solution translation. Does NOT account for rotation.
- For peg-hole: checks radius compatibility (peg radius ≤ hole radius + tolerance).
- For planar faces: always returns feasible=1.0 (no collision check).
- Overlap threshold is 10% of source volume — anything below is "minor overlap, accepted".

---

## Candidate Registry

- Session-scoped, module-level `Map`. Cleared on `resetRuntimeForNewScene`.
- Keyed by **canonical sorted key** (`min(srcId,tgtId):max(srcId,tgtId)`). Both `A:B` and `B:A`
  lookups resolve to the same candidates (2026-03-30).
- Candidates expire when the scene loads a new model.

---

## VLM Rerank

- **Integrated** (2026-03-30). `query.generate_candidates` accepts `vlmRerank?: boolean`.
- When `vlmRerank=true`: top 3 candidates sent to `agent.vlm_rerank_candidates` in wsGateway.
- LLM asked to score candidates 0–1 and optionally reject. Result merged into `scoreBreakdown.vlmRerank`.
- Candidate totalScore adjusted: `totalScore += vlmRerank * 0.15`. Candidates re-sorted after rerank.
- **Failure-safe**: if VLM rerank times out or errors, original candidates returned unmodified.

---

## Demonstration System

- `mate.record_demonstration` saves: sceneSnapshot, textExplanation, antiPattern,
  generalizedRule, chosenCandidateId.
- When `chosenCandidateId` is in registry: serializes feature pairs + solver transform.
- `chosenFeaturePairs` are **serialized** (plain IDs + scores) — full geometry is not stored.
- Saved to `data/demonstrations.json` on the server.
- **Retrieval prior integrated** (2026-03-30): `findRelevantDemonstrations()` + `getDemonstrationLearningContext()`
  in `mateRecipes.ts`. Scores on: part-name exact/partial match, feature type overlap, keyword match.
- Demo context is **automatically injected** into `mateParamsInfer.ts` alongside recipe context.
- `featureMatcher.ts` accepts `demonstrationPriors` option — boosts `recipePrior` score if top demo > 0.5.

---

## Known Not Implemented

- `tab` / `socket` / `rail` / `edge_notch` feature extraction (type exists, no extractor).
- Full geometry storage in demonstrations (only serialized IDs + scores).
- `solveTwoPairAlignment` is still greedy sequential — not proper simultaneous SVD.
