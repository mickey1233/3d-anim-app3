# Current Limitations

## Geometry Solver (Layer 3)
- `slot_insert`, `rim_align`, `rail_slide`: types declared, implementations pending
- `pattern_align`: requires ≥2 matched feature pairs; falls back to single-pair
- Collision detection: only bounding-box overlap heuristic (not mesh-level)
- No simultaneous multi-pair SVD (currently greedy sequential)

## Solver Scoring Framework (Layer 2)
- Entirely heuristic (hand-tuned weights) — no learned model
- Demo prior influence is keyword-based (coarse text matching)
- No cross-part-type generalization
- `symmetryResolutionGain`, `insertionAxisConfidence` not yet computed (always 0)

## VLM Semantic Layer (Layer 1)
- Only runs when AGENT_LLM_PROVIDER ≠ 'none' and API key configured
- Timeout: 6s (SEMANTIC_DESCRIBER_TIMEOUT_MS env var)
- Not yet wired into query.generate_candidates (semantic description not fetched automatically)
- Parser is best-effort JSON extraction

## Feature Extraction
- `tab`, `socket`, `rail`, `edge_notch`, `edge_connector`, `support_pad`: types declared, extraction not implemented
- Slot: Level-A recess-vertex (confidence ≤ 0.70), Level-B PCA fallback (confidence ≤ 0.35)
- No mesh-level face normal computation (uses AABB approximations)

## Learning System
- Demonstration priors: keyword-matched, not vector-embedded
- Recipe system: exact part-pair cache only
- Solver-family learning from demonstrations: keyword-based (coarse)
- No cross-session learned weights
