# Recipe Learning System

## Overview

The system learns from human corrections at two levels:

1. **Exact Recipe** — when the exact same part pair is requested again, skip LLM and
   return the saved face/method directly (100% confidence).
2. **Generalizable Pattern** — injected as few-shot examples into every LLM prompt,
   even for unseen part pairs (transferred reasoning).

A third level (new in v3):
3. **DemonstrationRecord** — richer learning signal with scene context, feature pairs,
   and the human's own words.

A fourth level (implemented 2026-03-30):
4. **Demonstration Retrieval Prior** — scored similarity search against saved demonstrations,
   injected into LLM prompts and candidate scoring without requiring exact part-name match.

---

## Level 1: Exact Recipe

**Storage**: `mcp-server/v2/router/mate-recipes.json`
**Key**: sorted uppercase part names joined with `|` (order-independent)

```json
{
  "PARTNAME_A|PARTNAME_B": {
    "sourceName": "PartName_A",
    "targetName": "PartName_B",
    "sourceFace": "bottom",
    "targetFace": "top",
    "sourceMethod": "planar_cluster",
    "targetMethod": "planar_cluster",
    "whyDescription": "User's explanation...",
    "pattern": "Generalizable English rule...",
    "antiPattern": "What NOT to do...",
    "geometrySignal": "Geometry characteristics...",
    "savedAt": "2026-03-15T10:30:00.000Z"
  }
}
```

**When triggered**: `inferMateParams()` checks recipes before calling LLM. If found,
returns `confidence: 1.0` with the saved parameters.

**MCP tool**: `mate.save_recipe` — saves or overwrites a recipe.

---

## Level 2: Generalizable Pattern

The `pattern` field of a recipe is injected into every LLM system prompt via
`getLearningContext()`. This means the LLM sees:

```
## Learned Assembly Patterns (from user corrections — HIGH PRIORITY)

### Example 1: HOR_FAN_LEFT ↔ HOR_FAN_RIGHT
- Correct assembly: HOR_FAN_LEFT (right) → HOR_FAN_RIGHT (left)
- Why (user's words): 這兩個風扇是左右並排的
- Generalizable rule: When two identical parts are positioned side-by-side
  horizontally (similar Y, different X), connect at their facing lateral faces.
- Anti-pattern: Do NOT use bottom→top — that stacks them vertically.
- Geometry signal: same bbox dimensions, large dx, near-zero dy
```

This allows the LLM to apply the rule to new, unseen part pairs that match the
same geometric pattern.

**How to write a good pattern**:
- Do NOT: "HOR_FAN_LEFT uses right face"  ← too specific
- Do: "When two identical/similar parts are side-by-side horizontally, use lateral faces"  ← generalizable
- Include: part type, relative position, assembly intent, wrong assumption to avoid

---

## Level 3: DemonstrationRecord (New in v3)

**Storage**: `mcp-server/v2/router/mate-demonstrations.json`
**Format**: Array of `DemonstrationRecord` objects

```json
[
  {
    "id": "uuid",
    "timestamp": "2026-03-15T10:30:00.000Z",
    "sourcePartId": "uuid",
    "sourcePartName": "PartName_A",
    "targetPartId": "uuid",
    "targetPartName": "PartName_B",
    "chosenCandidateId": "uuid of selected MatingCandidate",
    "textExplanation": "User's explanation in their own words",
    "antiPattern": "What to avoid",
    "generalizedRule": "AI-generated rule",
    "sceneSnapshot": {
      "partId1": { "position": [...], "quaternion": [...] },
      "partId2": { "position": [...], "quaternion": [...] }
    }
  }
]
```

**When triggered**: `mate.record_demonstration` MCP tool — typically called when
the user explicitly confirms a candidate from `query.generate_candidates`.

**Future use**: Demonstrations form a training dataset for:
- Fine-tuning VLM reranking
- Improving feature extraction (which features mattered?)
- Building assembly sequence models

---

## Level 4: Demonstration Retrieval Prior (implemented 2026-03-30)

**API**: `findRelevantDemonstrations()` and `getDemonstrationLearningContext()` in `mateRecipes.ts`

**Scoring algorithm**:
- Part name exact match (either order): +0.6
- Part name partial/substring match: +0.3
- Feature type overlap (fraction of featureTypes in demo's pairs): +0 to +0.3
- Keyword match in `generalizedRule` or `textExplanation`: +0 to +0.1

**Injection path**: `mateParamsInfer.ts` calls both `getLearningContext()` (recipe patterns)
and `getDemonstrationLearningContext()` in parallel, combines them, and prepends to the LLM
system prompt. This means ALL saved demonstrations influence future LLM decisions.

**Candidate scoring**: `featureMatcher.ts` accepts `options.demonstrationPriors`. When the
highest relevant demo score > 0.5, `scoreBreakdown.recipePrior += 0.1 * topDemoScore`.

**Example injected text**:
```
## Relevant Assembly Demonstrations
(retrieved for: HOR_FAN_LEFT ↔ HOR_FAN_RIGHT)

Demo #1 (score=0.90, part match): HOR_FAN_LEFT ↔ HOR_FAN_RIGHT
  Reason: Side-by-side fans connect laterally, not top/bottom
  Rule: When identical parts are horizontally adjacent, use lateral faces
  Anti-pattern: Do NOT stack (top/bottom)
```

---

## Comparison

| Property | Exact Recipe | Generalizable Pattern | Demonstration | Retrieval Prior |
|----------|-------------|----------------------|---------------|-----------------|
| Precision | Exact part pair | Similar situations | Any assembly | Scored similarity |
| LLM bypass | Yes | No (used as context) | No | No |
| Feature-level | No | No | Yes (when candidate chosen) | Optional overlap |
| Scene context | No | No | Yes | No |
| Human words | Optional | Optional | Required | Via stored demo |
| Storage | mate-recipes.json | (same file) | mate-demonstrations.json | (same) |
| MCP tool | mate.save_recipe | mate.save_recipe | mate.record_demonstration | (automatic) |

---

## Workflow: User Corrects the AI

1. AI assembles part A onto part B incorrectly
2. User says "remember this mate" / "記住這個組裝"
3. AI asks: "Why is this the correct assembly?"
4. User explains in their own words
5. AI generates: `pattern`, `antiPattern`, `geometrySignal`
6. `mate.save_recipe` saves Level 1 (exact) + Level 2 (generalizable)
7. (Optional) `mate.record_demonstration` saves Level 3 (rich context)

---

## Cache Management

In-memory caches are maintained in `mateRecipes.ts`:
- `cache: RecipeStore | null` — recipe store
- `demoCache: DemonstrationStore | null` — demonstration store

Clear with:
- `clearRecipeCache()` — invalidates recipe cache
- `clearDemoCache()` — invalidates demonstration cache

These are called during hot-reload and testing.
