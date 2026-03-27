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
- **First version.** Uses 2D PCA on all vertices of a planar cluster.
- Detects the overall shape of the face, not individual slot pockets.
- Aspect ratio threshold is 2.0 — may produce false positives on elongated flat faces.
- Depth is estimated as `width * 0.5` — not measured from geometry.
- `localSecondaryAxis` is the PCA principal axis, not necessarily the slot opening direction.

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
- **Stub.** Falls back to single-pair.

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
- Keyed by `sourcePartId:targetPartId`. Reverse direction (tgt→src) is not stored.
- Candidates expire when the scene loads a new model.

---

## VLM Rerank

- `scoreBreakdown.vlmRerank` field exists but is **not populated** by any current code path.
- `vlm.capture_for_mate` + `structuredMate.ts` run independently and do not feed back
  into `generateMatingCandidates`.
- To connect: caller would need to run VLM analysis, parse result, and adjust candidate
  scores manually.

---

## Demonstration System

- `mate.record_demonstration` saves: sceneSnapshot, textExplanation, antiPattern,
  generalizedRule, chosenCandidateId.
- When `chosenCandidateId` is in registry: serializes feature pairs + solver transform.
- `chosenFeaturePairs` are **serialized** (plain IDs + scores) — full geometry is not stored.
- Saved to `data/demonstrations.json` on the server. No indexing or retrieval API beyond
  `agent.list_demonstrations`.
- Demonstrations are **not yet injected** into the router agent's context automatically.

---

## Known Not Implemented

- `pattern_align` solver (bolt-circle, 4-hole patterns).
- `tab` / `socket` / `rail` / `edge_notch` feature extraction (type exists, no extractor).
- VLM rerank integration with candidate scores.
- Reverse candidate lookup (target→source direction in registry).
