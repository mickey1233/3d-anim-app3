# VLM Role in the Assembly System

## Summary

VLM (Vision-Language Model) is a **candidate reranker and visual verifier**, NOT a primary
geometry solver. It provides semantic understanding that pure geometry cannot — but it cannot
replace reliable math for position/rotation computation.

---

## What VLM Does

### 1. Candidate Reranking
Given a set of `MatingCandidate[]` from the feature-based pipeline, VLM can:
- Look at multi-angle renders of both parts
- Identify the mating features by appearance ("the peg on the left part fits the hole on the right")
- Reorder candidates by matching its visual assessment to feature descriptions
- Set the `vlmRerank` score in the candidate's `scoreBreakdown`

### 2. Semantic Labeling
VLM can label features that geometry extraction missed or misclassified:
- "The cylindrical protrusion is a snap latch, not a simple peg"
- "The rectangular notch is a PCB edge connector slot"
- These labels can override `extractedBy: 'vlm_hint'` features

### 3. Visual Verification
After a mate is executed, VLM can verify it looks correct:
- Capture the assembled scene
- Ask "does this look correctly assembled?"
- Return a confidence score and description

---

## What VLM Does NOT Do

| Not VLM's job | Why |
|---------------|-----|
| Compute rotation quaternions | Must be exact — VLM is probabilistic |
| Compute translation vectors | Must be exact — VLM is probabilistic |
| Detect circular holes precisely | Circle fit is more accurate than VLM |
| Replace feature extraction | Geometry is cheaper and more reliable |
| Be the sole decision maker | Always combined with geometry scoring |

---

## Current Integration Points

### `mcp-server/v2/vlm/structuredMate.ts`
Primary VLM integration. Accepts multi-angle images of two parts and returns a structured
JSON with:
```json
{
  "sourceFace": "bottom",
  "targetFace": "top",
  "mode": "translate",
  "intent": "cover",
  "confidence": 0.85
}
```

This is used by `action.smart_mate_execute` as a face-selection hint, not as a solver.

### `anchorVerify.ts`
VLM verifies that the anchor (face center) resolved by geometry is the visually correct one.
If disagreement > threshold, the anchor method is re-run with the VLM's suggested face.

---

## VLM Providers

| Provider | Speed | Quality | Use Case |
|----------|-------|---------|----------|
| `gemini` | Fast | High | Production default |
| `ollama` | Slow (local) | Medium | Air-gapped / dev |
| `mock` | Instant | N/A | Testing |
| `none` | N/A | N/A | Disable VLM entirely |

Set via `V2_VLM_PROVIDER=auto|gemini|ollama|mock|none`.

---

## VLM Reranking Pipeline (Future)

```
MatingCandidate[] from featureMatcher
        │
        ▼
captureMultiAngles(sourceObj)   captureMultiAngles(targetObj)
        │
        ▼
VLM prompt: "Which of these assembly candidates best matches
             what you see in these images?"
        │
        ▼
VLM returns: { candidateId: "...", confidence: 0.9, reasoning: "..." }
        │
        ▼
Adjust candidate.scoreBreakdown.vlmRerank
Re-sort candidates
        │
        ▼
Return to caller
```

---

## Design Principle

**Geometry is ground truth for math. VLM is ground truth for semantics.**

- Geometry tells us WHERE features are (positions, axes, dimensions)
- VLM tells us WHAT features mean (snap latch vs peg, sealing face vs mating face)
- The final assembly transform is always computed from geometry, not from VLM output
